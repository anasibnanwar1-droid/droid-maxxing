import type { NativeBrowserSelection } from './nativeBrowser';
import type { BrowserBox, BrowserElementRef, BrowserNativeSnapshot, DesignStrokePoint } from '../types/bridge';

interface AttachIframeDesignModeOptions {
  designMode: boolean;
  pencilMode: boolean;
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

  // Freehand pencil: SVG overlay for multi-stroke drawing.
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(svgNs, 'svg');
  svg.id = '__droidmaxx_pencil_svg';
  svg.setAttribute('style', [
    'position:fixed',
    'z-index:2147483646',
    'left:0',
    'top:0',
    'width:100vw',
    'height:100vh',
    'pointer-events:none',
  ].join(';'));
  svg.setAttribute('width', String(win.innerWidth));
  svg.setAttribute('height', String(win.innerHeight));

  let strokes: DesignStrokePoint[][] = [];
  let currentStroke: DesignStrokePoint[] | null = null;
  let currentPath: SVGPolylineElement | null = null;

  // Shift-drag text range highlight.
  const textHighlight = makeBox(doc, '__droidmaxx_text_highlight', [
    'background:rgba(47,128,237,.25)',
    'border-radius:2px',
    'mix-blend-mode:multiply',
  ]);
  let textDragStart: Point | null = null;

  doc.documentElement.append(overlay, label, svg, textHighlight);

  const onMouseMove = (event: MouseEvent) => {
    if (options.pencilMode) return;
    const target = pickTarget(doc.elementFromPoint(event.clientX, event.clientY));
    if (!target) {
      hideHover(overlay, label);
      return;
    }
    showHover(win, overlay, label, target.getBoundingClientRect(), labelFor(target));
  };

  const onClick = (event: MouseEvent) => {
    if (options.pencilMode) return;
    if (event.shiftKey) {
      // Shift+click alone won't reach here because mousedown handles shift-drag.
      return;
    }
    const target = pickTarget(doc.elementFromPoint(event.clientX, event.clientY));
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    // Any pending pencil strokes are attached to this element selection rather
    // than emitted as a separate region, so clicking after drawing produces a
    // single annotated reference instead of a duplicate region + element pair.
    showHover(win, overlay, label, target.getBoundingClientRect(), labelFor(target), '#ff8a2a');
    options.onSelection(selectionFor(win, doc, target, strokes));
    strokes = [];
  };

  // -- Shift-drag text range selection --
  const onShiftPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    textDragStart = { x: event.clientX, y: event.clientY };
  };

  const onShiftPointerMove = (event: PointerEvent) => {
    if (!textDragStart) return;
    event.preventDefault();
    event.stopPropagation();
    const box = boundingBox(textDragStart, { x: event.clientX, y: event.clientY });
    textHighlight.style.display = 'block';
    textHighlight.style.left = `${box.x}px`;
    textHighlight.style.top = `${box.y}px`;
    textHighlight.style.width = `${box.width}px`;
    textHighlight.style.height = `${box.height}px`;
  };

  const onShiftPointerUp = (event: PointerEvent) => {
    if (!textDragStart) return;
    event.preventDefault();
    event.stopPropagation();
    const end = { x: event.clientX, y: event.clientY };
    const box = boundingBox(textDragStart, end);
    const startPt = { ...textDragStart };
    textDragStart = null;
    textHighlight.style.display = 'none';
    if (box.width < 8 || box.height < 8) return;
    // Try to extract text via caretRangeFromPoint for precise range.
    let text = '';
    try {
      const startCaret = (doc as any).caretRangeFromPoint?.(startPt.x, startPt.y);
      const endCaret = (doc as any).caretRangeFromPoint?.(end.x, end.y);
      if (startCaret && endCaret) {
        // Order the carets by document position so a reverse drag (end before
        // start) does not collapse the range and drop the selected text.
        const backwards = startCaret.compareBoundaryPoints(Range.START_TO_START, endCaret) > 0;
        const first = backwards ? endCaret : startCaret;
        const second = backwards ? startCaret : endCaret;
        const range = doc.createRange();
        range.setStart(first.startContainer, first.startOffset);
        range.setEnd(second.startContainer, second.startOffset);
        text = cleanText(range.toString());
      }
    } catch { /* fallback below */ }
    if (!text) {
      text = cleanText(win.getSelection()?.toString() ?? '');
    }
    commitPencilStrokes();
    options.onSelection({
      anchor: {
        id: `@text-${Date.now().toString(36)}`,
        kind: 'text',
        label: text || 'text selection',
        text: text || undefined,
        box,
      },
      url: win.location.href,
      title: doc.title,
      scroll: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
    });
    strokes = [];
  };

  // -- Freehand pencil drawing --
  const onPencilPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    currentStroke = [{ x: Math.round(event.clientX), y: Math.round(event.clientY) }];
    currentPath = doc.createElementNS(svgNs, 'polyline');
    currentPath.setAttribute('fill', 'none');
    currentPath.setAttribute('stroke', '#7c4dff');
    currentPath.setAttribute('stroke-width', '3');
    currentPath.setAttribute('stroke-linecap', 'round');
    currentPath.setAttribute('stroke-linejoin', 'round');
    currentPath.setAttribute('points', `${event.clientX},${event.clientY}`);
    svg.appendChild(currentPath);
  };

  const onPencilPointerMove = (event: PointerEvent) => {
    if (!currentStroke || !currentPath) return;
    event.preventDefault();
    event.stopPropagation();
    const pt = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
    currentStroke.push(pt);
    currentPath.setAttribute('points', currentPath.getAttribute('points') + ` ${pt.x},${pt.y}`);
  };

  const onPencilPointerUp = (event: PointerEvent) => {
    if (!currentStroke || !currentPath) return;
    event.preventDefault();
    event.stopPropagation();
    const pt = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
    currentStroke.push(pt);
    strokes.push(currentStroke);
    currentStroke = null;
    currentPath = null;
  };

  const commitPencilStrokes = () => {
    if (strokes.length === 0) return;
    const box = strokesBoundingBox(strokes);
    options.onSelection({
      anchor: {
        id: `@pencil-${Date.now().toString(36)}`,
        kind: 'region',
        label: 'pencil annotation',
        box,
        strokes,
      },
      url: win.location.href,
      title: doc.title,
      scroll: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
    });
  };

  // Unified pointer handlers that dispatch based on mode.
  const onPointerDown = (event: PointerEvent) => {
    if (!options.pencilMode && event.shiftKey) {
      onShiftPointerDown(event);
    } else if (options.pencilMode) {
      onPencilPointerDown(event);
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!options.pencilMode && textDragStart) {
      onShiftPointerMove(event);
    } else if (options.pencilMode && currentStroke) {
      onPencilPointerMove(event);
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!options.pencilMode && textDragStart) {
      onShiftPointerUp(event);
    } else if (options.pencilMode && currentStroke) {
      onPencilPointerUp(event);
    }
  };

  const onMouseLeave = () => {
    if (!currentStroke && !textDragStart) hideHover(overlay, label);
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
    svg.remove();
    textHighlight.remove();
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

function selectionFor(win: Window, doc: Document, el: Element, strokes: DesignStrokePoint[][] = []): NativeBrowserSelection {
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
    strokes: strokes.length > 0 ? strokes : undefined,
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

function boundingBox(a: Point, b: Point) {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    width: Math.round(Math.abs(a.x - b.x)),
    height: Math.round(Math.abs(a.y - b.y)),
  };
}

function strokesBoundingBox(strokes: DesignStrokePoint[][]): BrowserBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const stroke of strokes) {
    for (const pt of stroke) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  }
  const pad = 4;
  return {
    x: Math.round(minX - pad),
    y: Math.round(minY - pad),
    width: Math.round(maxX - minX + pad * 2),
    height: Math.round(maxY - minY + pad * 2),
  };
}
