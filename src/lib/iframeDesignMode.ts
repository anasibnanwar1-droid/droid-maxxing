import type { NativeBrowserSelection } from './nativeBrowser';
import type { BrowserElementRef, BrowserNativeSnapshot } from '../types/bridge';

interface AttachIframeDesignModeOptions {
  designMode: boolean;
  sketchMode: boolean;
  onSelection: (selection: NativeBrowserSelection) => void;
}

type Point = { x: number; y: number };

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY']);
const TEXT_TAGS = new Set(['BLOCKQUOTE', 'CODE', 'EM', 'FIGCAPTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LABEL', 'LI', 'P', 'PRE', 'SMALL', 'SPAN', 'STRONG', 'TD', 'TH']);
const INTERACTIVE_ROLES = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'option', 'radio', 'searchbox', 'switch', 'tab', 'textbox']);

export function attachIframeDesignMode(
  iframe: HTMLIFrameElement,
  options: AttachIframeDesignModeOptions,
): () => void {
  if (!options.designMode) return () => {};
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win || !doc.documentElement) return () => {};

  let dragStart: Point | null = null;
  const overlay = makeBox(doc, '__droidmaxx_fallback_design_overlay', [
    'border:2px solid #2997ff',
    'box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 0 99999px rgba(0,0,0,.08)',
    'border-radius:4px',
  ]);
  const label = doc.createElement('div');
  label.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'pointer-events:none',
    'max-width:360px',
    'padding:6px 8px',
    'border-radius:7px',
    'background:#1f8fff',
    'color:white',
    'font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    'box-shadow:0 10px 28px rgba(0,0,0,.28)',
    'display:none',
  ].join(';');
  const region = makeBox(doc, '__droidmaxx_fallback_design_region', [
    'border:3px solid #7c4dff',
    'border-radius:999px',
    'background:rgba(124,77,255,.08)',
  ]);

  doc.documentElement.append(overlay, label, region);

  const onMouseMove = (event: MouseEvent) => {
    if (options.sketchMode || dragStart) return;
    const target = pickTarget(doc.elementFromPoint(event.clientX, event.clientY));
    if (!target) {
      hideHover(overlay, label);
      return;
    }
    showHover(win, overlay, label, target.getBoundingClientRect(), labelFor(target));
  };

  const onClick = (event: MouseEvent) => {
    if (options.sketchMode) return;
    const target = pickTarget(doc.elementFromPoint(event.clientX, event.clientY));
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    showHover(win, overlay, label, target.getBoundingClientRect(), labelFor(target), '#ff8a2a');
    options.onSelection(selectionFor(win, doc, target));
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!options.sketchMode) return;
    event.preventDefault();
    event.stopPropagation();
    dragStart = { x: event.clientX, y: event.clientY };
    drawRegion(region, dragStart, dragStart);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragStart) return;
    event.preventDefault();
    event.stopPropagation();
    drawRegion(region, dragStart, { x: event.clientX, y: event.clientY });
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!dragStart) return;
    event.preventDefault();
    event.stopPropagation();
    const box = drawRegion(region, dragStart, { x: event.clientX, y: event.clientY });
    dragStart = null;
    if (box.width >= 8 && box.height >= 8) {
      options.onSelection({
        anchor: {
          id: `@region-${Date.now().toString(36)}`,
          kind: 'region',
          label: 'region',
          box,
        },
        url: win.location.href,
        title: doc.title,
        scroll: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
      });
    }
  };

  const onMouseLeave = () => {
    if (!dragStart) hideHover(overlay, label);
  };

  doc.addEventListener('mousemove', onMouseMove, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointermove', onPointerMove, true);
  doc.addEventListener('pointerup', onPointerUp, true);
  doc.addEventListener('mouseleave', onMouseLeave, true);

  return () => {
    doc.removeEventListener('mousemove', onMouseMove, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('pointermove', onPointerMove, true);
    doc.removeEventListener('pointerup', onPointerUp, true);
    doc.removeEventListener('mouseleave', onMouseLeave, true);
    overlay.remove();
    label.remove();
    region.remove();
  };
}

export function snapshotIframe(iframe: HTMLIFrameElement, fallbackUrl: string): BrowserNativeSnapshot {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    return { url: fallbackUrl, title: undefined, scroll: { x: 0, y: 0 }, refs: [] };
  }
  return {
    url: win.location.href,
    title: doc.title,
    scroll: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
    refs: collectRefs(doc),
  };
}

export async function clickIframe(iframe: HTMLIFrameElement, x: number, y: number): Promise<void> {
  const doc = iframe.contentDocument;
  if (!doc) throw new Error('Droid Control browser page is not inspectable yet.');
  const target = doc.elementFromPoint(x, y);
  if (!target) throw new Error(`No browser element at ${Math.round(x)},${Math.round(y)}.`);
  const eventOptions = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  (target as HTMLElement).focus?.();
  target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
  target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
  target.dispatchEvent(new MouseEvent('click', eventOptions));
}

export async function typeIntoIframe(iframe: HTMLIFrameElement, text: string): Promise<void> {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) throw new Error('Droid Control browser page is not inspectable yet.');
  const el = doc.activeElement;
  if (!el) throw new Error('No focused browser element for typing.');
  const value = String(text);
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.setRangeText(value, start, end, 'end');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if ((el as HTMLElement).isContentEditable) {
    doc.execCommand('insertText', false, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    return;
  }
  throw new Error('Focused browser element is not text-editable.');
}

export async function keypressIframe(iframe: HTMLIFrameElement, key: string): Promise<void> {
  const doc = iframe.contentDocument;
  if (!doc) throw new Error('Droid Control browser page is not inspectable yet.');
  const el = doc.activeElement || doc.body;
  const value = String(key);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  if (value === 'Enter' && el.tagName === 'INPUT') {
    (el as HTMLInputElement).form?.requestSubmit?.();
  }
  el.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true, cancelable: true }));
}

export async function scrollIframe(iframe: HTMLIFrameElement, direction: string, pixels = 500): Promise<void> {
  const win = iframe.contentWindow;
  if (!win) throw new Error('Droid Control browser page is not loaded yet.');
  const amount = Math.max(1, Math.round(pixels));
  const left = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
  const top = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
  win.scrollBy({ left, top, behavior: 'auto' });
}

function makeBox(doc: Document, id: string, styles: string[]): HTMLDivElement {
  doc.getElementById(id)?.remove();
  const node = doc.createElement('div');
  node.id = id;
  node.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'left:0',
    'top:0',
    'width:0',
    'height:0',
    'pointer-events:none',
    'display:none',
    ...styles,
  ].join(';');
  return node;
}

function collectRefs(doc: Document): BrowserElementRef[] {
  const refs: BrowserElementRef[] = [];
  const root = doc.body || doc.documentElement;
  const walker = doc.createTreeWalker(root, 1);
  let node: Node | null = root;
  while (node && refs.length < 80) {
    if (node.nodeType === Node.ELEMENT_NODE && isCandidate(node as Element)) {
      refs.push(refFor(node as Element, refs.length + 1));
    }
    node = walker.nextNode();
  }
  return refs;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function directText(el: Element): string {
  return cleanText([...el.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join(' '));
}

function roleFor(el: Element): string {
  return el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' } as Record<string, string>)[el.tagName] || '';
}

function isCandidate(el: Element): boolean {
  if (el === el.ownerDocument.body || el === el.ownerDocument.documentElement) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const viewportArea = Math.max(1, el.ownerDocument.defaultView!.innerWidth * el.ownerDocument.defaultView!.innerHeight);
  const area = rect.width * rect.height;
  if (area > viewportArea * 0.72) return false;
  const role = roleFor(el).toLowerCase();
  if (INTERACTIVE_TAGS.has(el.tagName) || INTERACTIVE_ROLES.has(role)) return true;
  if (TEXT_TAGS.has(el.tagName) && cleanText((el as HTMLElement).innerText || el.textContent)) return true;
  if (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-testid')) return true;
  return Boolean(directText(el)) && area < viewportArea * 0.35;
}

function pickTarget(start: Element | null): Element | null {
  let node = start;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== node.ownerDocument.documentElement) {
    if (isCandidate(node)) return node;
    node = node.parentElement;
  }
  return null;
}

function selectorFor(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${cssEscape(testId)}"]`;
  const aria = el.getAttribute('aria-label');
  if (aria) return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== el.ownerDocument.documentElement && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((child) => child.tagName === node!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

function stableId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return `@live-${Math.abs(hash).toString(36)}`;
}

function selectionFor(win: Window, doc: Document, el: Element): NativeBrowserSelection {
  const rect = el.getBoundingClientRect();
  const selector = selectorFor(el);
  const text = cleanText((el as HTMLElement).innerText || el.textContent);
  const name = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || directText(el) || text);
  const tag = el.tagName.toLowerCase();
  const role = roleFor(el) || undefined;
  const box = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  const id = stableId(selector);
  let selectorVerified = false;
  try {
    selectorVerified = doc.querySelector(selector) === el;
  } catch {
    selectorVerified = false;
  }
  return {
    anchor: {
      id,
      kind: 'element',
      label: labelFor(el),
      tag,
      role,
      name: name || undefined,
      text: text || undefined,
      box,
    },
    detail: {
      id,
      selector,
      selectorVerified,
      attributes: attrsFor(el),
      styles: stylesFor(el),
      ancestors: ancestorsFor(el),
    },
    url: win.location.href,
    title: doc.title,
    scroll: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
  };
}

function ancestorsFor(el: Element): { tag: string; selector?: string }[] {
  const chain: { tag: string; selector?: string }[] = [];
  let node: Element | null = el.parentElement;
  while (node && node !== el.ownerDocument.documentElement && chain.length < 4) {
    chain.push({ tag: node.tagName.toLowerCase(), selector: node.id ? `#${cssEscape(node.id)}` : undefined });
    node = node.parentElement;
  }
  return chain;
}

function labelFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const label = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || directText(el) || el.getAttribute('data-testid') || el.id || tag).slice(0, 48);
  return `${label || tag} · ${tag}`;
}

function refFor(el: Element, index: number): BrowserElementRef {
  const rect = el.getBoundingClientRect();
  const text = cleanText((el as HTMLElement).innerText || el.textContent);
  const name = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || directText(el) || text);
  return {
    ref: `@b${index}`,
    selector: selectorFor(el),
    tagName: el.tagName.toLowerCase(),
    role: roleFor(el) || undefined,
    name: name || undefined,
    text: text || undefined,
    attributes: attrsFor(el),
    className: typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.slice(0, 160) : undefined,
    box: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    computedStyles: stylesFor(el),
  };
}

function attrsFor(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['id', 'class', 'data-testid', 'aria-label', 'title', 'placeholder', 'type', 'href', 'name', 'value']) {
    const value = el.getAttribute(name);
    if (value) out[name] = value.slice(0, 160);
  }
  return out;
}

function stylesFor(el: Element): Record<string, string> {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el) ?? getComputedStyle(el);
  return {
    color: style.color,
    backgroundColor: style.backgroundColor,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    display: style.display,
  };
}

function showHover(win: Window, overlay: HTMLElement, label: HTMLElement, rect: DOMRect, text: string, color = '#2997ff'): void {
  overlay.style.display = 'block';
  overlay.style.borderColor = color;
  overlay.style.left = `${Math.round(rect.x)}px`;
  overlay.style.top = `${Math.round(rect.y)}px`;
  overlay.style.width = `${Math.round(rect.width)}px`;
  overlay.style.height = `${Math.round(rect.height)}px`;
  label.style.display = 'block';
  label.textContent = text;
  label.style.left = `${Math.min(win.innerWidth - 16, Math.max(8, Math.round(rect.x)))}px`;
  label.style.top = `${Math.min(win.innerHeight - 36, Math.max(8, Math.round(rect.y - 38)))}px`;
}

function hideHover(overlay: HTMLElement, label: HTMLElement): void {
  overlay.style.display = 'none';
  label.style.display = 'none';
}

function drawRegion(region: HTMLElement, start: Point, end: Point) {
  const box = {
    x: Math.round(Math.min(start.x, end.x)),
    y: Math.round(Math.min(start.y, end.y)),
    width: Math.round(Math.abs(start.x - end.x)),
    height: Math.round(Math.abs(start.y - end.y)),
  };
  region.style.display = 'block';
  region.style.left = `${box.x}px`;
  region.style.top = `${box.y}px`;
  region.style.width = `${box.width}px`;
  region.style.height = `${box.height}px`;
  return box;
}
