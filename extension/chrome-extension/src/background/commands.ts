import { trajectoryStore } from '@extension/storage';
import { capturePageState, captureScreenshot, clearHighlights } from './perception';
import { executeAction } from './actions/executor';
import { groundTarget } from './agent/grounder';

export interface CommandResult {
  text: string;
  /** Optional data-URL image to render in the chat */
  image?: string;
}

const HELP = [
  'Commands:',
  '/state — list interactive elements with numbered highlights',
  '/screenshot — capture the visible tab',
  '/click <n> — click element n',
  '/type <n> <text> — type into element n',
  '/scroll up|down — scroll the page',
  '/nav <url> — navigate the tab',
  '/back — go back in history',
  '/ground <description> — locate an element visually (Holo) and click it',
  '/nohighlight — remove element highlights',
  '/trajectory — show logged trajectory step count',
  '/export — download logged trajectories as training-ready JSONL',
  '/help — this message',
].join('\n');

// Execute a slash command from the side panel against the active tab.
// This is the manual test surface for the perception/executor layer until
// the agent loop (Phase 3) drives it.
export async function handleCommand(command: string, tabId: number, sessionId: string): Promise<CommandResult> {
  const [verb, ...rest] = command.trim().split(/\s+/);

  switch (verb) {
    case '/help':
      return { text: HELP };

    case '/state': {
      const state = await capturePageState(tabId, true);
      const lines = state.elements.map(el => {
        const label = el.text || el.placeholder || el.href || '';
        const kind = el.role && el.role !== el.tag ? `${el.tag}:${el.role}` : el.tag;
        return `[${el.index}] <${kind}> ${label}`.trim();
      });
      const header =
        `${state.title} — ${state.url}\n` +
        `scroll ${state.scroll.y}/${state.scroll.pageHeight}px — ${state.elements.length} interactive elements:`;
      return { text: `${header}\n${lines.join('\n')}`, image: state.screenshot };
    }

    case '/screenshot': {
      const shot = await captureScreenshot(tabId);
      return { text: `Screenshot of the visible tab (${shot.width}×${shot.height}):`, image: shot.dataUrl };
    }

    case '/click': {
      const index = Number.parseInt(rest[0], 10);
      if (Number.isNaN(index)) return { text: 'Usage: /click <element-index>' };
      const result = await executeAction(tabId, sessionId, { type: 'click', index });
      return { text: result.message };
    }

    case '/type': {
      const index = Number.parseInt(rest[0], 10);
      const text = rest.slice(1).join(' ');
      if (Number.isNaN(index) || !text) return { text: 'Usage: /type <element-index> <text>' };
      const result = await executeAction(tabId, sessionId, { type: 'type', index, text });
      return { text: result.message };
    }

    case '/scroll': {
      const direction = rest[0] === 'up' ? 'up' : 'down';
      const result = await executeAction(tabId, sessionId, { type: 'scroll', direction });
      return { text: result.message };
    }

    case '/nav': {
      if (!rest[0]) return { text: 'Usage: /nav <url>' };
      const result = await executeAction(tabId, sessionId, { type: 'navigate', url: rest[0] });
      return { text: result.message };
    }

    case '/back': {
      const result = await executeAction(tabId, sessionId, { type: 'back' });
      return { text: result.message };
    }

    case '/ground': {
      const description = rest.join(' ');
      if (!description) return { text: 'Usage: /ground <visual description of the element>' };
      await clearHighlights(tabId).catch(() => {});
      const point = await groundTarget(tabId, description, new AbortController().signal);
      const result = await executeAction(tabId, sessionId, {
        type: 'click_at',
        x: point.x,
        y: point.y,
        target: description,
      });
      return { text: `Grounded "${description}" at (${point.x}, ${point.y}) — ${result.message}` };
    }

    case '/nohighlight':
      await clearHighlights(tabId);
      return { text: 'Highlights removed.' };

    case '/trajectory': {
      const sessionIds = await trajectoryStore.getSessionIds();
      const counts = await Promise.all(
        sessionIds.map(async id => `${id.slice(0, 8)}…: ${(await trajectoryStore.getSteps(id)).length} steps`),
      );
      return { text: counts.length ? `Trajectory log:\n${counts.join('\n')}` : 'Trajectory log is empty.' };
    }

    default:
      return { text: `Unknown command: ${verb}\n\n${HELP}` };
  }
}
