const { contextBridge, ipcRenderer } = require('electron');

let designMode = false;
let sketchMode = false;
let dragStart = null;
let promptBox = null;
let promptInput = null;
let promptSelection = null;

const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY']);
const interactiveRoles = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'option', 'radio', 'searchbox', 'switch', 'tab', 'textbox']);
const textTags = new Set(['BLOCKQUOTE', 'CODE', 'EM', 'FIGCAPTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LABEL', 'LI', 'P', 'PRE', 'SMALL', 'SPAN', 'STRONG', 'TD', 'TH']);

const overlay = element('div', [
  'position:fixed', 'z-index:2147483647', 'left:0', 'top:0', 'width:0', 'height:0',
  'pointer-events:none', 'border:2px solid #2997ff',
  'box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 0 99999px rgba(0,0,0,.08)',
  'border-radius:4px', 'display:none',
]);
const label = element('div', [
  'position:fixed', 'z-index:2147483647', 'pointer-events:none', 'max-width:360px',
  'padding:6px 8px', 'border-radius:7px', 'background:#1f8fff', 'color:white',
  'font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
  'box-shadow:0 10px 28px rgba(0,0,0,.28)', 'display:none',
]);
const region = element('div', [
  'position:fixed', 'z-index:2147483647', 'pointer-events:none', 'border:3px solid #7c4dff',
  'border-radius:999px', 'background:rgba(124,77,255,.08)', 'display:none',
]);

contextBridge.exposeInMainWorld('__DROIDMAXX_APPLY_DESIGN_STATE', applyState);
contextBridge.exposeInMainWorld('__DROIDMAXX_AGENT_ACTION', runAgentAction);

window.addEventListener('DOMContentLoaded', mount);
document.addEventListener('mousemove', onMouseMove, true);
document.addEventListener('mousedown', onMouseDown, true);
document.addEventListener('mouseup', onMouseUp, true);
document.addEventListener('click', onClick, true);

function element(tag, styles) {
  const node = document.createElement(tag);
  node.style.cssText = styles.join(';');
  return node;
}

function mount() {
  const root = document.documentElement;
  if (!root) return;
  if (!overlay.isConnected) root.appendChild(overlay);
  if (!label.isConnected) root.appendChild(label);
  if (!region.isConnected) root.appendChild(region);
}

function applyState(state) {
  designMode = Boolean(state && state.designMode);
  sketchMode = designMode && Boolean(state && state.sketchMode);
  dragStart = null;
  if (!designMode) {
    hideBox();
    hidePrompt();
    region.style.display = 'none';
    return;
  }
  mount();
  hideBox();
  if (!sketchMode) region.style.display = 'none';
}

function onMouseMove(event) {
  if (!designMode) return;
  if (isPromptEvent(event)) return;
  if (sketchMode && dragStart) {
    drawRegion(dragStart, point(event));
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (sketchMode || dragStart) return;
  const target = pickTarget(document.elementFromPoint(event.clientX, event.clientY));
  if (!target) {
    hideBox();
    return;
  }
  showBox(target.getBoundingClientRect(), labelFor(target));
}

function onMouseDown(event) {
  if (!designMode || !sketchMode) return;
  if (isPromptEvent(event)) return;
  dragStart = point(event);
  drawRegion(dragStart, dragStart);
  event.preventDefault();
  event.stopPropagation();
}

function onMouseUp(event) {
  if (!designMode || !sketchMode || !dragStart) return;
  if (isPromptEvent(event)) return;
  const box = drawRegion(dragStart, point(event));
  dragStart = null;
  if (box.width >= 8 && box.height >= 8) {
    const selection = {
      id: `@region-${Date.now().toString(36)}`,
      kind: 'region',
      url: location.href,
      title: document.title,
      box,
    };
    sendSelection(selection);
    showPrompt(selection);
  }
  event.preventDefault();
  event.stopPropagation();
}

function onClick(event) {
  if (!designMode || sketchMode) return;
  if (isPromptEvent(event)) return;
  const target = pickTarget(document.elementFromPoint(event.clientX, event.clientY));
  if (!target) return;
  const selection = payloadFor(target);
  sendSelection(selection);
  showPrompt(selection);
  event.preventDefault();
  event.stopPropagation();
}

async function runAgentAction(request) {
  try {
    const action = request && request.action;
    if (action === 'click') clickAt(Number(request.x), Number(request.y));
    else if (action === 'type') typeIntoFocused(request.text || '');
    else if (action === 'keypress') pressKey(request.key || '');
    else if (action === 'scroll') scrollPage(request.direction || 'down', Number(request.pixels || 500));
    else if (action !== 'snapshot') throw new Error(`Unsupported browser action: ${action}`);
    await settle();
    sendAgent({ requestId: request.requestId, ok: true, snapshot: pageSnapshot() });
  } catch (err) {
    sendAgent({
      requestId: request && request.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      snapshot: safeSnapshot(),
    });
  }
}

function clickAt(x, y) {
  const target = document.elementFromPoint(x, y);
  if (!target) throw new Error(`No element at ${x},${y}`);
  target.focus && target.focus();
  for (const type of ['mousedown', 'mouseup', 'click']) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  }
}

function typeIntoFocused(text) {
  const active = document.activeElement;
  if (!active) throw new Error('No focused element for typing.');
  const value = String(text);
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart == null ? active.value.length : active.selectionStart;
    const end = active.selectionEnd == null ? active.value.length : active.selectionEnd;
    active.setRangeText(value, start, end, 'end');
    active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    active.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (active.isContentEditable) {
    document.execCommand('insertText', false, value);
    active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    return;
  }
  throw new Error('Focused element is not text-editable.');
}

function pressKey(key) {
  const active = document.activeElement || document.body;
  const value = String(key);
  active.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  if (value === 'Enter' && active instanceof HTMLInputElement && active.form) active.form.requestSubmit();
  active.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true, cancelable: true }));
}

function scrollPage(direction, pixels) {
  const dx = direction === 'left' ? -pixels : direction === 'right' ? pixels : 0;
  const dy = direction === 'up' ? -pixels : direction === 'down' ? pixels : 0;
  window.scrollBy({ left: dx, top: dy, behavior: 'auto' });
}

function safeSnapshot() {
  try {
    return pageSnapshot();
  } catch {
    return { url: location.href, title: document.title, scroll: { x: 0, y: 0 }, refs: [] };
  }
}

function pageSnapshot() {
  return {
    url: location.href,
    title: document.title,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    refs: collectRefs(),
  };
}

function collectRefs() {
  const refs = [];
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = root;
  while (node && refs.length < 80) {
    if (isCandidate(node)) refs.push(refFor(node, refs.length + 1));
    node = walker.nextNode();
  }
  return refs;
}

function refFor(el, index) {
  const rect = el.getBoundingClientRect();
  const text = cleanText(el.innerText || el.textContent);
  const name = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || directText(el) || text);
  return {
    ref: `@b${index}`,
    selector: selectorFor(el),
    tagName: el.tagName.toLowerCase(),
    role: roleFor(el) || undefined,
    name: name || undefined,
    text: text || undefined,
    attributes: attrsFor(el),
    className: typeof el.className === 'string' ? el.className.slice(0, 160) : undefined,
    box: boxFor(rect),
    computedStyles: stylesFor(el),
  };
}

function payloadFor(el) {
  const rect = el.getBoundingClientRect();
  const selector = selectorFor(el);
  const text = cleanText(el.innerText || el.textContent);
  const name = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || directText(el) || text);
  return {
    id: `@live-${stableHash(selector)}`,
    kind: 'element',
    url: location.href,
    title: document.title,
    selector,
    tagName: el.tagName.toLowerCase(),
    role: roleFor(el) || undefined,
    name: name || undefined,
    text: text || undefined,
    box: boxFor(rect),
  };
}

function isCandidate(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const area = rect.width * rect.height;
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  if (area > viewportArea * 0.72) return false;
  const role = roleFor(el).toLowerCase();
  if (interactiveTags.has(el.tagName) || interactiveRoles.has(role) || el.onclick || el.tabIndex >= 0) return true;
  if (textTags.has(el.tagName) && cleanText(el.innerText || el.textContent)) return true;
  if (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-testid')) return true;
  return Boolean(directText(el)) && area < viewportArea * 0.35;
}

function pickTarget(start) {
  let best = null;
  let node = start;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
    if (isCandidate(node)) best = best || node;
    node = node.parentElement;
  }
  return best;
}

function selectorFor(el) {
  if (el.id) return `#${cssEscape(el.id)}`;
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${cssEscape(testId)}"]`;
  const aria = el.getAttribute('aria-label');
  if (aria) return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
  const parts = [];
  let node = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function attrsFor(el) {
  const out = {};
  for (const name of ['id', 'class', 'data-testid', 'aria-label', 'title', 'placeholder', 'type', 'href', 'name', 'value']) {
    const value = el.getAttribute && el.getAttribute(name);
    if (value) out[name] = String(value).slice(0, 160);
  }
  return out;
}

function stylesFor(el) {
  const style = getComputedStyle(el);
  return {
    color: style.color,
    backgroundColor: style.backgroundColor,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    display: style.display,
  };
}

function showBox(rect, text) {
  mount();
  overlay.style.display = 'block';
  overlay.style.left = `${Math.round(rect.x)}px`;
  overlay.style.top = `${Math.round(rect.y)}px`;
  overlay.style.width = `${Math.round(rect.width)}px`;
  overlay.style.height = `${Math.round(rect.height)}px`;
  label.style.display = 'block';
  label.textContent = text;
  label.style.left = `${Math.min(window.innerWidth - 16, Math.max(8, Math.round(rect.x)))}px`;
  label.style.top = `${Math.min(window.innerHeight - 36, Math.max(8, Math.round(rect.y - 38)))}px`;
}

function hideBox() {
  overlay.style.display = 'none';
  label.style.display = 'none';
}

function drawRegion(start, end) {
  mount();
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(start.x - end.x);
  const height = Math.abs(start.y - end.y);
  region.style.display = 'block';
  region.style.left = `${Math.round(x)}px`;
  region.style.top = `${Math.round(y)}px`;
  region.style.width = `${Math.round(width)}px`;
  region.style.height = `${Math.round(height)}px`;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function labelFor(el) {
  const tag = el.tagName.toLowerCase();
  const value = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || directText(el) || el.getAttribute('data-testid') || el.id || tag).slice(0, 48);
  return `${value || tag} - ${tag}`;
}

function sendSelection(payload) {
  ipcRenderer.send('native-browser-selection', payload);
}

function sendDesignPrompt(payload) {
  ipcRenderer.send('native-browser-design-prompt', payload);
}

function sendAgent(payload) {
  ipcRenderer.send('native-browser-agent-result', payload);
}

function settle() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function point(event) {
  return { x: event.clientX, y: event.clientY };
}

function boxFor(rect) {
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}

function roleFor(el) {
  return el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' })[el.tagName] || '';
}

function directText(el) {
  return cleanText(Array.from(el.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent || '').join(' '));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function cleanPrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

function stableHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  return Math.abs(hash).toString(36);
}

function showPrompt(selection) {
  promptSelection = selection;
  mountPrompt();
  promptInput.value = '';
  positionPrompt(selection.box);
  promptBox.style.display = 'block';
  window.setTimeout(() => promptInput.focus({ preventScroll: true }), 0);
}

function hidePrompt() {
  promptSelection = null;
  if (promptBox) promptBox.style.display = 'none';
}

function mountPrompt() {
  if (!promptBox) {
    promptBox = element('form', [
      'position:fixed', 'z-index:2147483647', 'display:none', 'width:min(420px,calc(100vw - 24px))',
      'background:rgba(18,18,18,.96)', 'color:#f4f4f5', 'border:1px solid rgba(255,255,255,.16)',
      'border-radius:12px', 'box-shadow:0 20px 60px rgba(0,0,0,.42)', 'font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'padding:8px', 'box-sizing:border-box',
    ]);
    const row = element('div', ['display:flex', 'align-items:center', 'gap:8px']);
    const tag = element('div', [
      'max-width:120px', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
      'color:#9ca3af', 'font:11px ui-monospace,SFMono-Regular,Menlo,monospace',
    ]);
    tag.textContent = 'ref';
    promptInput = element('input', [
      'flex:1', 'min-width:0', 'height:32px', 'border:0', 'outline:0', 'background:transparent',
      'color:#f4f4f5', 'font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    ]);
    promptInput.placeholder = 'Describe the change';
    const send = element('button', [
      'width:32px', 'height:32px', 'border:0', 'border-radius:999px', 'background:#f4f4f5',
      'color:#111', 'font:15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', 'cursor:pointer',
    ]);
    send.type = 'submit';
    send.textContent = '>';
    const close = element('button', [
      'width:28px', 'height:28px', 'border:0', 'border-radius:7px', 'background:transparent',
      'color:#9ca3af', 'font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', 'cursor:pointer',
    ]);
    close.type = 'button';
    close.textContent = 'x';
    row.append(tag, promptInput, send, close);
    promptBox.append(row);
    promptBox.addEventListener('submit', (event) => {
      event.preventDefault();
      const instruction = cleanPrompt(promptInput.value);
      if (!instruction || !promptSelection) return;
      sendDesignPrompt({ selection: promptSelection, instruction });
      hidePrompt();
    });
    promptBox.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hidePrompt();
      }
    });
    close.addEventListener('click', hidePrompt);
    for (const type of ['mousedown', 'mouseup', 'click', 'mousemove', 'wheel']) {
      promptBox.addEventListener(type, (event) => event.stopPropagation(), true);
    }
  }
  if (!promptBox.isConnected) document.documentElement.appendChild(promptBox);
}

function positionPrompt(box) {
  const width = Math.min(420, Math.max(280, window.innerWidth - 24));
  const height = 50;
  const left = clamp(box.x, 12, Math.max(12, window.innerWidth - width - 12));
  const below = box.y + box.height + 10;
  const above = box.y - height - 10;
  const top = below + height <= window.innerHeight - 12 ? below : above;
  promptBox.style.left = `${Math.round(left)}px`;
  promptBox.style.top = `${Math.round(clamp(top, 12, Math.max(12, window.innerHeight - height - 12)))}px`;
}

function isPromptEvent(event) {
  return Boolean(promptBox && event.target && promptBox.contains(event.target));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
