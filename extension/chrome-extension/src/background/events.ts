import type { Actors } from '@extension/storage';
import { createLogger } from './log';

const logger = createLogger('events');

export function postExecutionEvent(
  port: chrome.runtime.Port,
  actor: Actors,
  state: string,
  taskId: string,
  details = '',
  meta?: string,
) {
  try {
    port.postMessage({
      type: 'execution',
      actor,
      state,
      data: { taskId, step: 0, maxSteps: 0, details, meta },
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error('Failed to send message to side panel:', error);
  }
}
