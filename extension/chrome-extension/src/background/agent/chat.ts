import { Actors, chatHistoryStore, chatSettingsStore } from '@extension/storage';
import { createLogger } from '../log';
import { postExecutionEvent } from '../events';

const logger = createLogger('chat');

const CHAT_SYSTEM_PROMPT =
  'You are a helpful assistant running fully locally in a browser side panel. ' +
  'Answer the user directly and concisely. Use plain text, not markdown.';

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Rebuild the model conversation from the persisted chat session.
// The side panel saves the user message before sending the task, but the
// write may still be in flight, so append the task if it is not there yet.
async function buildChatMessages(taskId: string, task: string): Promise<OllamaChatMessage[]> {
  const messages: OllamaChatMessage[] = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }];

  const session = await chatHistoryStore.getSession(taskId).catch(() => null);
  if (session) {
    for (const message of session.messages) {
      if (message.actor === Actors.USER) {
        // Slash commands drive the executor, not the model — keep them out of chat context
        if (message.content.startsWith('/')) continue;
        messages.push({ role: 'user', content: message.content });
      } else if (message.actor === Actors.ASSISTANT) {
        messages.push({ role: 'assistant', content: message.content });
      }
      // SYSTEM messages are UI notices (errors, cancellations), not model context
    }
  }

  const last = messages[messages.length - 1];
  if (!(last.role === 'user' && last.content === task)) {
    messages.push({ role: 'user', content: task });
  }
  return messages;
}

/**
 * Stream a conversational reply from the local model to the side panel.
 * Emits task.start, stream_chunk messages, then task.ok with the full text.
 */
export async function streamChatReply(
  port: chrome.runtime.Port,
  taskId: string,
  task: string,
  signal: AbortSignal,
): Promise<void> {
  const { baseUrl, model } = await chatSettingsStore.getSettings();
  postExecutionEvent(port, Actors.SYSTEM, 'task.start', taskId);

  try {
    const messages = await buildChatMessages(taskId, task);
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // think: false — qwen3.5 supports non-thinking mode; skip reasoning tokens for snappy chat
      body: JSON.stringify({ model, messages, stream: true, think: false }),
      signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama request failed (HTTP ${response.status}). Is Ollama running at ${baseUrl}?`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    // Ollama streams newline-delimited JSON chunks
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line);
        if (chunk.error) throw new Error(chunk.error);
        const delta: string = chunk.message?.content ?? '';
        if (delta) {
          fullText += delta;
          port.postMessage({ type: 'stream_chunk', taskId, delta });
        }
      }
    }

    postExecutionEvent(port, Actors.ASSISTANT, 'task.ok', taskId, fullText, `⌂ ${model} (local) · $0`);
  } catch (error) {
    if (signal.aborted) {
      postExecutionEvent(port, Actors.SYSTEM, 'task.cancel', taskId, 'Stopped.');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Chat failed:', message);
      postExecutionEvent(port, Actors.SYSTEM, 'task.fail', taskId, message);
    }
  }
}
