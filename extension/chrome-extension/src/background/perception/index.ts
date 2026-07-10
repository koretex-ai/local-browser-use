import type { PerceptionSnapshot } from '@extension/storage';
import { createLogger } from '../log';
import { extractInteractiveElements, removeHighlights } from './pageScript';
import type { ExtractedPageState } from './pageScript';

const logger = createLogger('perception');

// Latency is image-prefill bound (~5s/call at full res on the M3 Pro), so
// downscaling is a first-class lever: cap width and recompress aggressively.
const MAX_SCREENSHOT_WIDTH = 1024;
const SCREENSHOT_JPEG_QUALITY = 0.7;

async function runInPage<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  ...args: Args
): Promise<Result> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args as never,
  });
  return injection?.result as Result;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function downscaleDataUrl(dataUrl: string): Promise<string> {
  const source = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / source.width);
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(source, 0, 0, width, height);
  source.close();

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: SCREENSHOT_JPEG_QUALITY });
  return blobToDataUrl(blob);
}

export async function captureScreenshot(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
  return downscaleDataUrl(raw);
}

// Capture the hybrid perception snapshot: DOM set-of-marks AND pixels together,
// so every trajectory step carries the vision-superset training data.
export async function capturePageState(tabId: number, showHighlights: boolean): Promise<PerceptionSnapshot> {
  const dom: ExtractedPageState = await runInPage(tabId, extractInteractiveElements, showHighlights);
  if (!dom) throw new Error('DOM extraction returned no result — is this a restricted page (chrome://, Web Store)?');

  const screenshot = await captureScreenshot(tabId);
  logger.info('captured page state', dom.url, `${dom.elements.length} elements`);

  return {
    url: dom.url,
    title: dom.title,
    scroll: dom.scroll,
    elements: dom.elements,
    screenshot,
    capturedAt: Date.now(),
  };
}

export async function clearHighlights(tabId: number): Promise<void> {
  await runInPage(tabId, removeHighlights);
}

export { runInPage };
