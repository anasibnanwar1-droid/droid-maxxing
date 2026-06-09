const { contextBridge, ipcRenderer } = require('electron');

let designMode = false;
let sketchMode = false;
let dragStart = null;
let altHeld = false;
let promptBox = null;
let promptInput = null;
let promptTag = null;
let promptSelection = null;
let annotations = [];
let repositionQueued = false;
let hoverFrame = 0;
let pendingHover = null;
let hoverTarget = null;
let penDrawing = false;
let penPoints = [];

const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY']);
const interactiveRoles = new Set(['button', 'checkbox', 'combobox', 'link', 'menuitem', 'option', 'radio', 'searchbox', 'switch', 'tab', 'textbox']);
const textTags = new Set(['BLOCKQUOTE', 'CODE', 'EM', 'FIGCAPTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LABEL', 'LI', 'P', 'PRE', 'SMALL', 'SPAN', 'STRONG', 'TD', 'TH']);
const mediaTags = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'PICTURE']);
const INTERNAL_ATTR = 'data-droid-design';

const overlay = element('div', [
  'position:fixed', 'z-index:2147483646', 'left:0', 'top:0', 'width:0', 'height:0',
  'pointer-events:none', 'border:2px solid #2997ff',
  'box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 0 99999px rgba(0,0,0,.08)',
  'border-radius:4px', 'display:none',
]);
const label = element('div', [
  'position:fixed', 'z-index:2147483646', 'pointer-events:none', 'max-width:360px',
  'padding:6px 8px', 'border-radius:7px', 'background:#1f8fff', 'color:white',
  'font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
  'box-shadow:0 10px 28px rgba(0,0,0,.28)', 'display:none',
]);
const region = element('div', [
  'position:fixed', 'z-index:2147483646', 'pointer-events:none', 'border:3px solid #7c4dff',
  'border-radius:6px', 'background:rgba(124,77,255,.08)', 'display:none',
]);
const penSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
penSvg.setAttribute('width', '100%');
penSvg.setAttribute('height', '100%');
penSvg.style.cssText = [
  'position:fixed', 'z-index:2147483646', 'left:0', 'top:0', 'width:100vw', 'height:100vh',
  'pointer-events:none', 'display:none', 'overflow:visible',
].join(';');
const penPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
penPath.setAttribute('fill', 'none');
penPath.setAttribute('stroke', '#7c4dff');
penPath.setAttribute('stroke-width', '3');
penPath.setAttribute('stroke-linecap', 'round');
penPath.setAttribute('stroke-linejoin', 'round');
penSvg.appendChild(penPath);
overlay.setAttribute(INTERNAL_ATTR, '1');
label.setAttribute(INTERNAL_ATTR, '1');
region.setAttribute(INTERNAL_ATTR, '1');
penSvg.setAttribute(INTERNAL_ATTR, '1');

contextBridge.exposeInMainWorld('__DROIDMAXX_APPLY_DESIGN_STATE', applyState);
contextBridge.exposeInMainWorld('__DROIDMAXX_AGENT_ACTION', runAgentAction);

window.addEventListener('DOMContentLoaded', mount);
document.addEventListener('mousemove', onMouseMove, true);
document.addEventListener('mousedown', onMouseDown, true);
document.addEventListener('mouseup', onMouseUp, true);
document.addEventListener('click', onClick, true);
document.addEventListener('contextmenu', onContextMenu, true);
document.addEventListener('keydown', onKey, true);
document.addEventListener('keyup', onKey, true);
window.addEventListener('scroll', queueReposition, true);
window.addEventListener('resize', queueReposition, true);

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
  if (!penSvg.isConnected) root.appendChild(penSvg);
}

function applyState(state) {
  designMode = Boolean(state && state.designMode);
  sketchMode = designMode && Boolean(state && state.sketchMode);
  dragStart = null;
  hoverTarget = null;
  penDrawing = false;
  penPoints = [];
  clearPen();
  if (!designMode) {
    hideBox();
    hidePrompt();
    region.style.display = 'none';
    clearAnnotations();
    return;
  }
  mount();
  hideBox();
  if (!sketchMode) region.style.display = 'none';
  repositionAnnotations();
}

function onKey(event) {
  if (!designMode) return;
  altHeld = Boolean(event.altKey);
}

function onMouseMove(event) {
  if (!designMode) return;
  if (isInternalEvent(event)) return;
  altHeld = Boolean(event.altKey);
  if (penDrawing) {
    penPoints.push(point(event));
    drawPen();
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (sketchMode && dragStart) {
    drawRegion(dragStart, point(event));
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (sketchMode || dragStart) return;
  pendingHover = { x: event.clientX, y: event.clientY, alt: altHeld };
  if (hoverFrame) return;
  hoverFrame = requestAnimationFrame(processHover);
}

function processHover() {
  hoverFrame = 0;
  if (!designMode || !pendingHover || sketchMode || dragStart || penDrawing) return;
  const { x, y, alt } = pendingHover;
  const target = pickTarget(x, y, alt);
  if (!target) {
    hoverTarget = null;
    hideBox();
    return;
  }
  if (target === hoverTarget) {
    overlay.style.display = 'block';
    const rect = target.getBoundingClientRect();
    overlay.style.left = `${Math.round(rect.x)}px`;
    overlay.style.top = `${Math.round(rect.y)}px`;
    overlay.style.width = `${Math.round(rect.width)}px`;
    overlay.style.height = `${Math.round(rect.height)}px`;
    return;
  }
  hoverTarget = target;
  showBox(target.getBoundingClientRect(), labelFor(target));
}

function onMouseDown(event) {
  if (!designMode) return;
  if (isInternalEvent(event)) return;
  if (event.button === 2) {
    penDrawing = true;
    penPoints = [point(event)];
    hideBox();
    drawPen();
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!sketchMode || event.button !== 0) return;
  dragStart = point(event);
  drawRegion(dragStart, dragStart);
  event.preventDefault();
  event.stopPropagation();
}

function onMouseUp(event) {
  if (!designMode) return;
  if (penDrawing) {
    penDrawing = false;
    const box = penBounds();
    if (box && box.width >= 8 && box.height >= 8) {
      const selection = regionSelection(box);
      addAnnotation(selection.anchor, null);
      drawPen();
      sendSelection(selection);
      showPrompt(selection);
    } else {
      clearPen();
    }
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!sketchMode || !dragStart) return;
  if (isInternalEvent(event)) {
    dragStart = null;
    region.style.display = 'none';
    return;
  }
  const box = drawRegion(dragStart, point(event));
  dragStart = null;
  if (box.width >= 8 && box.height >= 8) {
    const selection = regionSelection(box);
    addAnnotation(selection.anchor, null);
    sendSelection(selection);
    showPrompt(selection);
  }
  event.preventDefault();
  event.stopPropagation();
}

function onContextMenu(event) {
  if (!designMode) return;
  event.preventDefault();
  event.stopPropagation();
}

function onClick(event) {
  if (!designMode || sketchMode) return;
  if (isInternalEvent(event)) return;
  const target = pickTarget(event.clientX, event.clientY, Boolean(event.altKey));
  if (!target) return;
  const selection = elementSelection(target);
  addAnnotation(selection.anchor, target);
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
    return sendAgent({ requestId: request.requestId, ok: true, snapshot: pageSnapshot() });
  } catch (err) {
    return sendAgent({
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
    box: boxFor(rect),
  };
}

function elementSelection(el) {
  const selector = selectorFor(el);
  const verified = verifySelector(el, selector);
  const source = resolveSource(el);
  const anchor = buildAnchor(el, selector, source);
  const detail = buildDetail(el, selector, verified);
  return {
    anchor,
    detail,
    url: location.href,
    title: document.title,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
  };
}

function regionSelection(box) {
  const anchor = {
    id: `@region-${Date.now().toString(36)}`,
    kind: 'region',
    label: `region ${box.width}x${box.height}`,
    box,
  };
  return {
    anchor,
    url: location.href,
    title: document.title,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
  };
}

function buildAnchor(el, selector, source) {
  const rect = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const text = cleanText(el.innerText || el.textContent, 80);
  const name = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || directText(el) || text, 80);
  return {
    id: `@live-${stableHash(selector)}`,
    kind: 'element',
    label: labelText(tag, source, name || text),
    tag,
    role: roleFor(el) || undefined,
    name: name || undefined,
    text: text || undefined,
    box: boxFor(rect),
    source,
  };
}

function buildDetail(el, selector, verified) {
  return {
    id: `@live-${stableHash(selector)}`,
    selector,
    selectorVerified: verified,
    attributes: attrsFor(el),
    styles: stylesFor(el),
    ancestors: ancestorsFor(el),
    html: cleanText(el.outerHTML, 400) || undefined,
  };
}

function labelText(tag, source, text) {
  const component = source && source.component ? `${source.component} \u203a ` : '';
  const quoted = text ? ` "${cleanText(text, 40)}"` : '';
  return `${component}<${tag}>${quoted}`;
}

function isCandidate(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  if (el.getAttribute(INTERNAL_ATTR)) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const area = rect.width * rect.height;
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
  if (area > viewportArea * 0.72) return false;
  const role = roleFor(el).toLowerCase();
  if (interactiveTags.has(el.tagName) || interactiveRoles.has(role) || el.onclick || el.tabIndex >= 0) return true;
  if (textTags.has(el.tagName) && cleanText(el.innerText || el.textContent)) return true;
  if (mediaTags.has(el.tagName)) return true;
  if (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-testid')) return true;
  return Boolean(directText(el)) && area < viewportArea * 0.35;
}

function pickTarget(x, y, climb) {
  let node = document.elementFromPoint(x, y);
  while (node && node.getAttribute && node.getAttribute(INTERNAL_ATTR)) node = node.parentElement;
  if (!node || node === document.documentElement) return null;
  if (climb) {
    const parent = node.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) return parent;
  }
  return node;
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

function verifySelector(el, selector) {
  if (!selector) return false;
  try {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === el;
  } catch {
    return false;
  }
}

function attrsFor(el) {
  const out = {};
  for (const name of ['id', 'class', 'data-testid', 'aria-label', 'title', 'placeholder', 'type', 'href', 'name', 'value', 'role']) {
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
    padding: style.padding,
    margin: style.margin,
    border: style.border,
  };
}

function ancestorsFor(el) {
  const out = [];
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement && out.length < 4) {
    const testId = node.getAttribute('data-testid');
    out.push({
      tag: node.tagName.toLowerCase(),
      selector: node.id ? `#${cssEscape(node.id)}` : testId ? `[data-testid="${cssEscape(testId)}"]` : undefined,
    });
    node = node.parentElement;
  }
  return out;
}

function resolveSource(el) {
  const react = resolveReact(el);
  if (react && react.file) return react;
  const attr = resolveAttributes(el);
  if (attr && attr.file) {
    if (react) {
      attr.component = attr.component || react.component;
      attr.componentChain = attr.componentChain || react.componentChain;
      attr.framework = attr.framework || react.framework;
    }
    return attr;
  }
  const vue = resolveVue(el);
  if (vue && vue.file) return vue;
  const svelte = resolveSvelte(el);
  if (svelte && svelte.file) return svelte;
  return react || vue || svelte || attr || { confidence: 'none' };
}

function resolveReact(el) {
  const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
  if (!key) return undefined;
  let fiber = el[key] || null;
  let file;
  let line;
  let column;
  const chain = [];
  let guard = 0;
  while (fiber && guard < 200) {
    guard += 1;
    if (!file && fiber._debugSource && typeof fiber._debugSource.fileName === 'string') {
      file = normalizeFile(fiber._debugSource.fileName);
      line = numberOr(fiber._debugSource.lineNumber);
      column = numberOr(fiber._debugSource.columnNumber);
    }
    const name = componentName(fiber.type);
    if (name && chain[chain.length - 1] !== name && chain.length < 6) chain.push(name);
    fiber = fiber._debugOwner || fiber.return || null;
  }
  if (!file && chain.length === 0) return undefined;
  return {
    framework: 'react',
    component: chain[0],
    componentChain: chain.length ? chain.slice().reverse() : undefined,
    file,
    line,
    column,
    confidence: file ? 'exact' : 'heuristic',
  };
}

function resolveVue(el) {
  let instance = el.__vueParentComponent || (el.__vnode && el.__vnode.component) || el.__vue__;
  if (!instance) return undefined;
  let file;
  const chain = [];
  let guard = 0;
  while (instance && guard < 200) {
    guard += 1;
    const type = instance.type || instance.$options;
    if (!file && type && typeof type.__file === 'string') file = normalizeFile(type.__file);
    const name = type && (type.name || type.__name);
    if (name && chain[chain.length - 1] !== name && chain.length < 6) chain.push(name);
    instance = instance.parent || instance.$parent;
  }
  if (!file && chain.length === 0) return undefined;
  return {
    framework: 'vue',
    component: chain[0],
    componentChain: chain.length ? chain.slice().reverse() : undefined,
    file,
    confidence: file ? 'exact' : 'heuristic',
  };
}

function resolveSvelte(el) {
  let node = el;
  let guard = 0;
  while (node && guard < 200) {
    guard += 1;
    const meta = node.__svelte_meta;
    if (meta && meta.loc && typeof meta.loc.file === 'string') {
      return {
        framework: 'svelte',
        file: normalizeFile(meta.loc.file),
        line: numberOr(meta.loc.line),
        column: numberOr(meta.loc.column),
        confidence: 'exact',
      };
    }
    node = node.parentElement;
  }
  return undefined;
}

function resolveAttributes(el) {
  let node = el;
  let guard = 0;
  while (node && guard < 200) {
    guard += 1;
    const path = node.getAttribute('data-inspector-relative-path') || node.getAttribute('data-source-file') || node.getAttribute('data-sourcefile') || node.getAttribute('data-source');
    if (path) {
      return {
        component: node.getAttribute('data-component') || node.getAttribute('data-testid') || undefined,
        file: normalizeFile(path),
        line: numberOr(node.getAttribute('data-inspector-line') || node.getAttribute('data-source-line')),
        column: numberOr(node.getAttribute('data-inspector-column') || node.getAttribute('data-source-column')),
        confidence: 'attribute',
      };
    }
    node = node.parentElement;
  }
  return undefined;
}

function componentName(type) {
  if (typeof type === 'function') {
    const name = type.displayName || type.name;
    return name && /^[A-Z]/.test(name) ? name : undefined;
  }
  if (type && typeof type === 'object') {
    const name = type.displayName || type.name;
    return name && /^[A-Z]/.test(name) ? name : undefined;
  }
  return undefined;
}

function normalizeFile(file) {
  if (!file) return undefined;
  let normalized = String(file).replace(/[?#].*$/, '');
  const fsIndex = normalized.indexOf('/@fs/');
  if (fsIndex >= 0) normalized = normalized.slice(fsIndex + 4);
  normalized = normalized.replace(/^https?:\/\/[^/]+/, '');
  const srcIndex = normalized.lastIndexOf('/src/');
  if (srcIndex >= 0) return normalized.slice(srcIndex + 1);
  return normalized.replace(/^\//, '');
}

function numberOr(value) {
  const num = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(num) ? num : undefined;
}

function addAnnotation(anchor, el) {
  clearAnnotations();
  const outline = element('div', [
    'position:fixed', 'z-index:2147483645', 'pointer-events:none',
    'border:2px solid #ff8a2a', 'border-radius:4px',
    'box-shadow:0 0 0 1px rgba(0,0,0,.35)', 'display:block',
  ]);
  const pin = element('div', [
    'position:fixed', 'z-index:2147483645', 'pointer-events:none',
    'min-width:18px', 'height:18px', 'padding:0 5px', 'border-radius:9px',
    'background:#ff8a2a', 'color:#111', 'font:11px ui-monospace,SFMono-Regular,Menlo,monospace',
    'display:flex', 'align-items:center', 'justify-content:center', 'box-shadow:0 4px 12px rgba(0,0,0,.4)',
  ]);
  outline.setAttribute(INTERNAL_ATTR, '1');
  pin.setAttribute(INTERNAL_ATTR, '1');
  pin.textContent = '1';
  document.documentElement.append(outline, pin);
  annotations.push({ anchor, el, outline, pin });
  repositionAnnotations();
}

function clearAnnotations() {
  for (const item of annotations) {
    item.outline.remove();
    item.pin.remove();
  }
  annotations = [];
  clearPen();
}

function queueReposition() {
  if (repositionQueued) return;
  repositionQueued = true;
  requestAnimationFrame(() => {
    repositionQueued = false;
    repositionAnnotations();
  });
}

function repositionAnnotations() {
  for (const item of annotations) {
    const rect = item.el ? item.el.getBoundingClientRect() : item.anchor.box;
    const box = item.el ? rect : { x: item.anchor.box.x, y: item.anchor.box.y, width: item.anchor.box.width, height: item.anchor.box.height };
    const visible = designMode && box.width > 0 && box.height > 0;
    item.outline.style.display = visible ? 'block' : 'none';
    item.pin.style.display = visible ? 'flex' : 'none';
    if (!visible) continue;
    item.outline.style.left = `${Math.round(box.x)}px`;
    item.outline.style.top = `${Math.round(box.y)}px`;
    item.outline.style.width = `${Math.round(box.width)}px`;
    item.outline.style.height = `${Math.round(box.height)}px`;
    item.pin.style.left = `${Math.round(box.x)}px`;
    item.pin.style.top = `${Math.round(Math.max(2, box.y - 20))}px`;
  }
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

function drawPen() {
  mount();
  if (penPoints.length === 0) return;
  penSvg.style.display = 'block';
  const d = penPoints
    .map((pt, index) => `${index === 0 ? 'M' : 'L'}${Math.round(pt.x)} ${Math.round(pt.y)}`)
    .join(' ');
  penPath.setAttribute('d', d);
}

function penBounds() {
  if (penPoints.length < 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of penPoints) {
    minX = Math.min(minX, pt.x);
    minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x);
    maxY = Math.max(maxY, pt.y);
  }
  return { x: Math.round(minX), y: Math.round(minY), width: Math.round(maxX - minX), height: Math.round(maxY - minY) };
}

function clearPen() {
  penPath.setAttribute('d', '');
  penSvg.style.display = 'none';
}

function labelFor(el) {
  const tag = el.tagName.toLowerCase();
  const source = resolveSource(el);
  const text = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || directText(el) || el.id || el.innerText || el.textContent || '', 40);
  const head = labelText(tag, source, text);
  if (source && source.file) {
    return `${head}  ${source.file}${source.line ? `:${source.line}` : ''}`;
  }
  return `${head}${altHeld ? '' : '  (alt: parent)'}`;
}

function sendSelection(payload) {
  ipcRenderer.send('native-browser-selection', payload);
}

function sendDesignPrompt(payload) {
  ipcRenderer.send('native-browser-design-prompt', payload);
}

function sendAgent(payload) {
  ipcRenderer.send('native-browser-agent-result', payload);
  return payload;
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

function cleanText(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
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
  if (promptTag) promptTag.textContent = selection.anchor.label || selection.anchor.id;
  promptInput.value = '';
  positionPrompt(selection.anchor.box);
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
      'position:fixed', 'z-index:2147483647', 'display:none', 'width:min(440px,calc(100vw - 24px))',
      'background:rgba(18,18,18,.96)', 'color:#f4f4f5', 'border:1px solid rgba(255,255,255,.16)',
      'border-radius:12px', 'box-shadow:0 20px 60px rgba(0,0,0,.42)', 'font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'padding:8px', 'box-sizing:border-box',
    ]);
    promptBox.setAttribute(INTERNAL_ATTR, '1');
    const row = element('div', ['display:flex', 'align-items:center', 'gap:8px']);
    promptTag = element('div', [
      'max-width:160px', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
      'color:#9ca3af', 'font:11px ui-monospace,SFMono-Regular,Menlo,monospace',
    ]);
    promptTag.textContent = '@ref';
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
    row.append(promptTag, promptInput, send, close);
    promptBox.append(row);
    promptBox.addEventListener('submit', (event) => {
      event.preventDefault();
      const instruction = cleanPrompt(promptInput.value);
      if (!instruction || !promptSelection) return;
      sendDesignPrompt({ selection: promptSelection, instruction });
      hidePrompt();
      clearAnnotations();
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
  const width = Math.min(440, Math.max(280, window.innerWidth - 24));
  const height = 50;
  const left = clamp(box.x, 12, Math.max(12, window.innerWidth - width - 12));
  const below = box.y + box.height + 10;
  const above = box.y - height - 10;
  const top = below + height <= window.innerHeight - 12 ? below : above;
  promptBox.style.left = `${Math.round(left)}px`;
  promptBox.style.top = `${Math.round(clamp(top, 12, Math.max(12, window.innerHeight - height - 12)))}px`;
}

function isInternalEvent(event) {
  return Boolean(event.target && event.target.closest && event.target.closest(`[${INTERNAL_ATTR}]`));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
