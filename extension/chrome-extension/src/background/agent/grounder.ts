import { chatSettingsStore } from '@extension/storage';
import { createLogger } from '../log';
import { captureScreenshot, runInPage, GROUNDER_SCREENSHOT_OPTS } from '../perception';
import { getViewportSize } from '../perception/pageScript';

const logger = createLogger('grounder');

// Prompt validated in the Phase-0 spike (phase0/run.py): Holo1.5-3B answers
// a plain JSON coordinate request reliably.
function groundingPrompt(width: number, height: number, instruction: string): string {
  return (
    `You are a web UI grounding model. The image is a ${width}x${height} pixel screenshot ` +
    `of a web page. Task: click ${instruction}\n` +
    'Reply with ONLY the pixel coordinates of the single point to click, as ' +
    `JSON: {"x": <int>, "y": <int>}. Coordinates are in image pixels ` +
    `(0,0 = top-left, max x=${width}, max y=${height}).`
  );
}

// Tolerant coordinate parse (mirrors phase0): JSON x/y first, then first number pair
function parseXY(text: string): { x: number; y: number } | null {
  const mx = text.match(/"?x"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  const my = text.match(/"?y"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  if (mx && my) return { x: Number(mx[1]), y: Number(my[1]) };
  const nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (nums && nums.length >= 2) return { x: Number(nums[0]), y: Number(nums[1]) };
  return null;
}

export interface GroundedPoint {
  /** Viewport CSS coordinates, ready for click_at */
  x: number;
  y: number;
  /** The instruction that was localized (trajectory/training metadata) */
  target: string;
}

/**
 * Vision grounding fallback: localize a natural-language target on the
 * current screenshot with the local VLM and return viewport coordinates.
 * ~5s/call (image-prefill bound) — use only when DOM grounding can't.
 */
export async function groundTarget(tabId: number, instruction: string, signal: AbortSignal): Promise<GroundedPoint> {
  const { baseUrl, grounderModel } = await chatSettingsStore.getSettings();
  const shot = await captureScreenshot(tabId, GROUNDER_SCREENSHOT_OPTS);
  const base64 = shot.dataUrl.replace(/^data:[^,]+,/, '');

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: grounderModel,
      messages: [
        {
          role: 'user',
          content: groundingPrompt(shot.width, shot.height, instruction),
          images: [base64],
        },
      ],
      stream: false,
      options: { temperature: 0 },
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Grounder request failed (HTTP ${response.status}). Is ${grounderModel} pulled?`);
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  const content: string = data.message?.content ?? '';
  logger.info('grounder response:', content.slice(0, 120));

  let point = parseXY(content);
  if (!point) throw new Error(`Grounder returned no coordinates: ${content.slice(0, 80)}`);

  // Some VLMs answer in 0-1000 normalized space; detect out-of-image values
  if (point.x > shot.width || point.y > shot.height) {
    point = { x: (point.x / 1000) * shot.width, y: (point.y / 1000) * shot.height };
  }

  // Scale image pixels -> viewport CSS pixels
  const viewport = await runInPage(tabId, getViewportSize);
  const scaleX = viewport.width / shot.width;
  const scaleY = viewport.height / shot.height;
  return {
    x: Math.round(point.x * scaleX),
    y: Math.round(point.y * scaleY),
    target: instruction,
  };
}
