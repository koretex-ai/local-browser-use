/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Functions in this file are injected into pages via chrome.scripting.executeScript.
 * They are serialized, so each must be fully self-contained: no imports, no
 * closures over module scope. Shared state lives on window.__lbu.
 */

export interface ExtractedPageState {
  url: string;
  title: string;
  scroll: { x: number; y: number; pageHeight: number; viewportHeight: number };
  elements: Array<{
    index: number;
    tag: string;
    role: string;
    text: string;
    placeholder: string;
    value: string;
    href: string;
    rect: { x: number; y: number; width: number; height: number };
  }>;
}

// Extract visible interactive elements, register them on window.__lbu, and
// optionally draw numbered set-of-marks overlays.
export function extractInteractiveElements(showHighlights: boolean): ExtractedPageState {
  const win = window as any;

  // Remove any previous overlay
  document.getElementById('__lbu_highlights')?.remove();

  const SELECTOR =
    'a, button, input, select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], ' +
    '[role="menuitem"], [role="option"], [role="combobox"], [role="textbox"], [role="switch"], ' +
    '[onclick], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

  const candidates = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR));

  const isVisible = (el: HTMLElement): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    // Viewport-only: set-of-marks describes what the eye (and screenshot) sees
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth)
      return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    // Hit-test the center: skip elements fully covered by others
    const cx = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const cy = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    if (hit && !el.contains(hit) && !hit.contains(el)) return false;
    return true;
  };

  const getLabel = (el: HTMLElement): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const text = (el.innerText || '').trim().replace(/\s+/g, ' ');
    if (text) return text.slice(0, 120);
    return el.getAttribute('title') || el.getAttribute('alt') || '';
  };

  const visible = candidates.filter(isVisible);
  // Drop elements whose interactive ancestor is already included (e.g. span inside <a>)
  const elements = visible.filter(el => !visible.some(other => other !== el && other.contains(el)));

  win.__lbu = { elements };

  const state: ExtractedPageState = {
    url: window.location.href,
    title: document.title,
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      pageHeight: Math.round(document.documentElement.scrollHeight),
      viewportHeight: Math.round(window.innerHeight),
    },
    elements: elements.map((el, index) => {
      const rect = el.getBoundingClientRect();
      return {
        index,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || (el as HTMLInputElement).type || '',
        text: getLabel(el),
        placeholder: el.getAttribute('placeholder') || '',
        value: (el as HTMLInputElement).value || '',
        href: (el as HTMLAnchorElement).href || '',
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    }),
  };

  if (showHighlights) {
    const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000'];
    const container = document.createElement('div');
    container.id = '__lbu_highlights';
    container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    for (const item of state.elements) {
      const color = COLORS[item.index % COLORS.length];
      const box = document.createElement('div');
      box.style.cssText =
        `position:fixed;left:${item.rect.x}px;top:${item.rect.y}px;` +
        `width:${item.rect.width}px;height:${item.rect.height}px;` +
        `border:2px solid ${color};box-sizing:border-box;`;
      const label = document.createElement('span');
      label.textContent = String(item.index);
      label.style.cssText =
        `position:absolute;top:-16px;left:0;background:${color};color:#fff;` +
        'font:bold 11px/14px monospace;padding:0 3px;border-radius:2px;';
      box.appendChild(label);
      container.appendChild(box);
    }
    document.body.appendChild(container);
  }

  return state;
}

// Remove set-of-marks overlays
export function removeHighlights(): void {
  document.getElementById('__lbu_highlights')?.remove();
}

// Click the element registered at the given index by the last extraction
export function clickElementByIndex(index: number): { ok: boolean; error?: string } {
  const win = window as any;
  const el: HTMLElement | undefined = win.__lbu?.elements?.[index];
  if (!el || !el.isConnected) return { ok: false, error: `No element at index ${index} — run /state to refresh` };
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }),
    );
  }
  el.click();
  return { ok: true };
}

// Type text into the element registered at the given index
export function typeIntoElement(index: number, text: string): { ok: boolean; error?: string } {
  const win = window as any;
  const el: HTMLElement | undefined = win.__lbu?.elements?.[index];
  if (!el || !el.isConnected) return { ok: false, error: `No element at index ${index} — run /state to refresh` };
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  el.focus();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Use the native setter so frameworks (React etc.) observe the change
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  }

  return { ok: false, error: `Element at index ${index} is not editable (<${el.tagName.toLowerCase()}>)` };
}

// Scroll the page by roughly one viewport
export function scrollPage(direction: 'up' | 'down', amount?: number): { ok: boolean } {
  const dy = (amount ?? Math.round(window.innerHeight * 0.75)) * (direction === 'down' ? 1 : -1);
  window.scrollBy({ top: dy, behavior: 'instant' as ScrollBehavior });
  return { ok: true };
}
