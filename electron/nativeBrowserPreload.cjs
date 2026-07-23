const { contextBridge, ipcRenderer } = require('electron');

let designMode = false;
let pencilMode = false;
let altHeld = false;
let promptBox = null;
let promptInput = null;
let promptTag = null;
let promptSend = null;
let promptSelection = null;
let annotations = [];
let repositionQueued = false;
let hoverFrame = 0;
let pendingHover = null;
let hoverTarget = null;
let strokes = [];
let strokePaths = [];
let activeStroke = null;
let activePath = null;
let textDragStart = null;
let textRange = null;
let clearTimer = null;
// True between submitting a design prompt and the main process acking that it
// has captured the annotated region. While set, all design interactions are
// frozen so the user cannot move/redraw/scroll mid-capture and produce a
// screenshot that no longer matches the reference. The id makes the ack
// request-scoped so a late ack from a superseded capture cannot clear a newer
// pending capture.
let capturePending = false;
let pendingCaptureId = null;
let captureSeq = 0;

const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY']);
const interactiveRoles = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'switch',
  'tab',
  'textbox',
]);
const textTags = new Set([
  'BLOCKQUOTE',
  'CODE',
  'EM',
  'FIGCAPTION',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LABEL',
  'LI',
  'P',
  'PRE',
  'SMALL',
  'SPAN',
  'STRONG',
  'TD',
  'TH',
]);
const mediaTags = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'PICTURE']);
const INTERNAL_ATTR = 'data-droid-design';
const PENCIL_COLOR = '#ff8a2a';
const designHost = document.createElement('div');
designHost.setAttribute(INTERNAL_ATTR, '1');
designHost.style.cssText = [
  'all:initial!important',
  'position:fixed!important',
  'left:0!important',
  'top:0!important',
  'width:0!important',
  'height:0!important',
  'display:block!important',
  'overflow:visible!important',
  'pointer-events:none!important',
  'z-index:2147483647!important',
].join(';');
const designRoot = designHost.attachShadow({ mode: 'closed' });

const overlay = element('div', [
  'position:fixed',
  'z-index:2147483646',
  'left:0',
  'top:0',
  'width:0',
  'height:0',
  'pointer-events:none',
  'border:2px solid #2997ff',
  'box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 0 99999px rgba(0,0,0,.08)',
  'border-radius:4px',
  'display:none',
]);
const label = element('div', [
  'position:fixed',
  'z-index:2147483646',
  'pointer-events:none',
  'max-width:360px',
  'padding:6px 8px',
  'border-radius:7px',
  'background:#1f8fff',
  'color:white',
  'font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
  'box-shadow:0 10px 28px rgba(0,0,0,.28)',
  'display:none',
]);
const textHighlights = element('div', [
  'position:fixed',
  'z-index:2147483645',
  'left:0',
  'top:0',
  'pointer-events:none',
  'display:none',
]);
const penSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
penSvg.setAttribute('width', '100%');
penSvg.setAttribute('height', '100%');
penSvg.style.cssText = [
  'position:fixed',
  'z-index:2147483646',
  'left:0',
  'top:0',
  'width:100vw',
  'height:100vh',
  'pointer-events:none',
  'display:none',
  'overflow:visible',
].join(';');
overlay.setAttribute(INTERNAL_ATTR, '1');
label.setAttribute(INTERNAL_ATTR, '1');
textHighlights.setAttribute(INTERNAL_ATTR, '1');
penSvg.setAttribute(INTERNAL_ATTR, '1');

contextBridge.exposeInMainWorld('__DROIDMAXX_APPLY_DESIGN_STATE', applyState);
contextBridge.exposeInMainWorld('__DROIDMAXX_AGENT_ACTION', runAgentAction);
// Credential autofill is driven entirely from the main process: the secret
// arrives here only to be written into the page's inputs and is never returned
// to any caller, so the agent can authorize a login without reading it.
contextBridge.exposeInMainWorld('__DROIDMAXX_FILL_CREDENTIALS', fillCredentials);

ipcRenderer.on('native-browser-design-prompt-sent', (_event, payload) => {
  // Ignore acks that do not match the capture currently in flight: a stale ack
  // from a superseded prompt must not clear a newer pending capture.
  if (pendingCaptureId === null || !payload || payload.captureId !== pendingCaptureId) return;
  finishCapture();
});

function finishCapture() {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  capturePending = false;
  pendingCaptureId = null;
  clearAnnotations();
}

window.addEventListener('DOMContentLoaded', mount);
document.addEventListener('submit', onFormSubmit, true);
document.addEventListener('mousemove', onMouseMove, true);
document.addEventListener('mousedown', onMouseDown, true);
document.addEventListener('mouseup', onMouseUp, true);
document.addEventListener('click', onClick, true);
document.addEventListener('contextmenu', onContextMenu, true);
document.addEventListener('keydown', onKey, true);
document.addEventListener('keyup', onKey, true);
window.addEventListener('scroll', queueReposition, true);
window.addEventListener('resize', queueReposition, true);
// passive:false so we can cancel wheel scrolling while a capture is pending.
window.addEventListener('wheel', onWheel, { capture: true, passive: false });
window.addEventListener('touchmove', onWheel, { capture: true, passive: false });

function element(tag, styles) {
  const node = document.createElement(tag);
  node.style.cssText = styles.join(';');
  return node;
}

function mount() {
  const root = document.documentElement;
  if (!root) return;
  if (!designHost.isConnected) root.appendChild(designHost);
  if (!overlay.isConnected) designRoot.appendChild(overlay);
  if (!label.isConnected) designRoot.appendChild(label);
  if (!textHighlights.isConnected) designRoot.appendChild(textHighlights);
  if (!penSvg.isConnected) designRoot.appendChild(penSvg);
}

function applyState(state) {
  designMode = Boolean(state && state.designMode);
  pencilMode = designMode && Boolean(state && state.pencilMode);
  hoverTarget = null;
  activeStroke = null;
  textDragStart = null;
  if (!designMode) {
    capturePending = false;
    pendingCaptureId = null;
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    hideBox();
    hidePrompt();
    clearAnnotations();
    return;
  }
  mount();
  hideBox();
  repositionAnnotations();
}

function onWheel(event) {
  if (!designMode || !capturePending) return;
  swallow(event);
}

function onKey(event) {
  if (!designMode) return;
  // Freeze keyboard scrolling (space, arrows, page keys) during capture so the
  // viewport cannot shift out from under the region being captured.
  if (capturePending) {
    if (event.type === 'keydown') swallow(event);
    return;
  }
  altHeld = Boolean(event.altKey);
  if (event.type === 'keydown' && event.key === 'Escape') {
    // Escape must cancel reliably even when focus is not inside the composer
    // (the composer's own handler only fires when it holds focus).
    if (promptVisible()) cancelDesign();
    else clearAnnotations();
  }
}

function onMouseMove(event) {
  if (!designMode) return;
  if (isInternalEvent(event)) return;
  if (capturePending) {
    swallow(event);
    return;
  }
  altHeld = Boolean(event.altKey);
  if (activeStroke) {
    activeStroke.push(point(event));
    extendActiveStroke();
    swallow(event);
    return;
  }
  if (textDragStart) {
    updateTextRange(textDragStart, point(event));
    swallow(event);
    return;
  }
  // While the prompt composer is open the selection is locked in, so the
  // cursor can travel to the prompt without re-triggering hover/marker.
  if (pencilMode || promptVisible()) return;
  pendingHover = { x: event.clientX, y: event.clientY, alt: altHeld };
  if (hoverFrame) return;
  hoverFrame = requestAnimationFrame(processHover);
}

function processHover() {
  hoverFrame = 0;
  if (
    !designMode ||
    !pendingHover ||
    pencilMode ||
    activeStroke ||
    textDragStart ||
    promptVisible()
  )
    return;
  const { x, y, alt } = pendingHover;
  const target = pickTarget(x, y, alt);
  if (!target) {
    hoverTarget = null;
    hideBox();
    return;
  }
  if (target === hoverTarget) {
    overlay.style.display = 'block';
    positionBox(overlay, target.getBoundingClientRect());
    return;
  }
  hoverTarget = target;
  showBox(target.getBoundingClientRect(), labelFor(target));
}

function onMouseDown(event) {
  if (!designMode || event.button !== 0) return;
  if (isInternalEvent(event)) return;
  if (capturePending) {
    swallow(event);
    return;
  }
  // Swallow so the underlying page cannot react to the press while the
  // composer is open; clicks elsewhere are also intercepted in onClick.
  if (promptVisible()) {
    swallow(event);
    return;
  }
  if (pencilMode) {
    activeStroke = [point(event)];
    strokes.push(activeStroke);
    activePath = appendStrokePath(activeStroke);
    hideBox();
    swallow(event);
    return;
  }
  if (event.shiftKey) {
    textDragStart = point(event);
    hideBox();
    swallow(event);
  }
}

function onMouseUp(event) {
  if (!designMode) return;
  if (capturePending) {
    swallow(event);
    return;
  }
  if (activeStroke) {
    const finished = strokes[strokes.length - 1];
    activeStroke = null;
    activePath = null;
    if (strokeLength(finished) < 6) {
      strokes.pop();
      const stalePath = strokePaths.pop();
      if (stalePath) stalePath.remove();
      if (strokes.length === 0) penSvg.style.display = 'none';
    } else {
      const selection = sketchSelection();
      if (selection) {
        sendSelection(selection);
        showPrompt(selection);
      }
    }
    swallow(event);
    return;
  }
  if (textDragStart) {
    const start = textDragStart;
    textDragStart = null;
    updateTextRange(start, point(event));
    const selection = textSelection();
    if (selection) {
      sendSelection(selection);
      showPrompt(selection);
    } else {
      clearTextHighlights();
    }
    swallow(event);
  }
}

function onContextMenu(event) {
  if (!designMode) return;
  swallow(event);
}

function onClick(event) {
  if (!designMode || pencilMode || event.shiftKey) return;
  if (isInternalEvent(event)) return;
  if (capturePending) {
    swallow(event);
    return;
  }
  if (promptVisible()) {
    swallow(event);
    return;
  }
  const target = pickTarget(event.clientX, event.clientY, Boolean(event.altKey));
  if (!target) return;
  const selection = elementSelection(target);
  addAnnotation(selection.anchor, target);
  sendSelection(selection);
  showPrompt(selection);
  swallow(event);
}

function swallow(event) {
  event.preventDefault();
  event.stopPropagation();
}

// Observe (never block) login submissions so the main process can offer to
// save the credential. The values flow straight to main over IPC and are
// encrypted there; nothing is stored in the page or exposed to the agent.
function onFormSubmit(event) {
  try {
    const form = event.target;
    if (!form || form.getAttribute(INTERNAL_ATTR)) return;
    const fields = form.querySelectorAll ? form.querySelectorAll('input') : [];
    let password = null;
    let username = null;
    for (const field of fields) {
      const type = (field.getAttribute('type') || '').toLowerCase();
      if (!password && type === 'password' && field.value) password = field.value;
      else if (
        !username &&
        (type === 'email' || type === 'text' || type === '' || type === 'tel') &&
        field.value
      )
        username = field.value;
    }
    if (!password) return;
    ipcRenderer.send('native-browser-credential-capture', {
      origin: location.origin,
      url: location.href,
      username: username || '',
      password,
    });
  } catch {
    /* never interfere with the page's own submit */
  }
}

function fillCredentials(payload) {
  try {
    const username = payload && typeof payload.username === 'string' ? payload.username : '';
    const password = payload && typeof payload.password === 'string' ? payload.password : '';
    if (!password) return { ok: false, filled: false };
    const passwordField = firstVisible(document.querySelectorAll('input[type="password"]'));
    if (!passwordField) return { ok: false, filled: false };
    if (username) {
      const userField = usernameFieldFor(passwordField);
      if (userField) setFieldValue(userField, username);
    }
    setFieldValue(passwordField, password);
    return { ok: true, filled: true };
  } catch (err) {
    return { ok: false, filled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function usernameFieldFor(passwordField) {
  const form = passwordField.form;
  const scope = form || document;
  const fields = scope.querySelectorAll('input');
  let previous = null;
  for (const field of fields) {
    if (field === passwordField) break;
    const type = (field.getAttribute('type') || '').toLowerCase();
    if ((type === 'email' || type === 'text' || type === 'tel' || type === '') && isVisible(field))
      previous = field;
  }
  return (
    previous ||
    firstVisible(
      scope.querySelectorAll(
        'input[type="email"],input[type="text"],input[type="tel"],input:not([type])',
      ),
    )
  );
}

function setFieldValue(field, value) {
  field.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

function firstVisible(nodes) {
  for (const node of nodes) if (isVisible(node)) return node;
  return null;
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

async function runAgentAction(request) {
  try {
    const action = request && request.action;
    if (action === 'click') clickAt(Number(request.x), Number(request.y));
    else if (action === 'selectOption') selectOption(request.selector, request.text || '');
    else if (action === 'type') typeIntoFocused(request.text || '');
    else if (action === 'keypress') pressKey(request.key || '');
    else if (action === 'scroll')
      scrollPage(request.direction || 'down', Number(request.pixels || 500));
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
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }),
    );
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
    active.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    );
    active.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (active.isContentEditable) {
    document.execCommand('insertText', false, value);
    active.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
    );
    return;
  }
  throw new Error('Focused element is not text-editable.');
}

function selectOption(selector, value) {
  if (!selector) throw new Error('Select option requires a target selector.');
  const target = document.querySelector(selector);
  if (!(target instanceof HTMLSelectElement)) {
    throw new Error('Target is not a select element.');
  }
  const expected = String(value);
  const option = Array.from(target.options).find(
    (item) => item.value === expected || cleanText(item.textContent) === expected,
  );
  if (!option) throw new Error(`Option "${expected}" is not available.`);
  target.value = option.value;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
}

function pressKey(key) {
  const active = document.activeElement || document.body;
  const value = String(key);
  active.dispatchEvent(
    new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
  );
  if (value === 'Enter' && active instanceof HTMLInputElement && active.form)
    active.form.requestSubmit();
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
    if (isCandidate(node)) refs.push(refFor(node));
    node = walker.nextNode();
  }
  return refs;
}

function refFor(el) {
  const rect = el.getBoundingClientRect();
  const text = cleanText(el.innerText || el.textContent);
  const selector = selectorFor(el);
  const name = cleanText(
    el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      directText(el) ||
      text,
  );
  return {
    ref: `@b-${stableHash(selector)}`,
    selector,
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

function sketchSelection() {
  const box = strokesBounds();
  if (!box) return null;
  return {
    anchor: {
      id: `@sketch-${Date.now().toString(36)}`,
      kind: 'region',
      label: `sketch (${strokes.length} stroke${strokes.length === 1 ? '' : 's'})`,
      box,
      strokes: strokes.map((stroke) =>
        stroke.map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) })),
      ),
    },
    url: location.href,
    title: document.title,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
  };
}

function updateTextRange(start, end) {
  const from = caretAt(start.x, start.y);
  const to = caretAt(end.x, end.y);
  if (!from || !to) return;
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    if (range.collapsed) {
      range.setStart(to.node, to.offset);
      range.setEnd(from.node, from.offset);
    }
  } catch {
    return;
  }
  if (range.collapsed) return;
  textRange = range;
  drawTextHighlights(range);
}

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

function textSelection() {
  if (!textRange || textRange.collapsed) return null;
  const text = cleanText(textRange.toString(), 400);
  if (!text) return null;
  const rect = textRange.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  const container = textRange.commonAncestorContainer;
  const el = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
  const selector = el ? selectorFor(el) : '';
  const source = el ? resolveSource(el) : undefined;
  return {
    anchor: {
      id: `@text-${stableHash(`${selector}:${text}`)}`,
      kind: 'text',
      label: `text "${cleanText(text, 40)}"`,
      tag: el ? el.tagName.toLowerCase() : undefined,
      text,
      box: boxFor(rect),
      source,
    },
    detail: el
      ? {
          id: `@text-${stableHash(`${selector}:${text}`)}`,
          selector,
          selectorVerified: verifySelector(el, selector),
          attributes: attrsFor(el),
          styles: stylesFor(el),
          ancestors: ancestorsFor(el),
          html: cleanText(el.outerHTML, 400) || undefined,
        }
      : undefined,
    url: location.href,
    title: document.title,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
  };
}

function drawTextHighlights(range) {
  mount();
  textHighlights.textContent = '';
  for (const rect of range.getClientRects()) {
    if (rect.width < 1 || rect.height < 1) continue;
    const piece = element('div', [
      'position:fixed',
      'pointer-events:none',
      'background:rgba(41,151,255,.3)',
      'border-radius:2px',
      `left:${Math.round(rect.x)}px`,
      `top:${Math.round(rect.y)}px`,
      `width:${Math.round(rect.width)}px`,
      `height:${Math.round(rect.height)}px`,
    ]);
    piece.setAttribute(INTERNAL_ATTR, '1');
    textHighlights.appendChild(piece);
  }
  textHighlights.style.display = 'block';
}

function clearTextHighlights() {
  textRange = null;
  textHighlights.textContent = '';
  textHighlights.style.display = 'none';
}

function buildAnchor(el, selector, source) {
  const rect = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const text = cleanText(el.innerText || el.textContent, 80);
  const name = cleanText(
    el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      directText(el) ||
      text,
    80,
  );
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
  if (
    interactiveTags.has(el.tagName) ||
    interactiveRoles.has(role) ||
    el.onclick ||
    el.tabIndex >= 0
  )
    return true;
  if (textTags.has(el.tagName) && cleanText(el.innerText || el.textContent)) return true;
  if (mediaTags.has(el.tagName)) return true;
  if (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-testid'))
    return true;
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
  while (
    node &&
    node.nodeType === Node.ELEMENT_NODE &&
    node !== document.documentElement &&
    parts.length < 5
  ) {
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
  const secret = isSensitiveField(el);
  for (const name of [
    'id',
    'class',
    'data-testid',
    'aria-label',
    'title',
    'placeholder',
    'type',
    'href',
    'name',
    'value',
    'role',
  ]) {
    const value = el.getAttribute && el.getAttribute(name);
    if (!value) continue;
    if (name === 'value' && secret) {
      out[name] = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      continue;
    }
    out[name] = String(value).slice(0, 160);
  }
  return out;
}

// Password and one-time-code fields must never reach the agent transcript, so
// their live values are redacted from every snapshot/detail payload.
function isSensitiveField(el) {
  if (!el || el.tagName !== 'INPUT') return false;
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password') return true;
  const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
  return auto.includes('password') || auto === 'one-time-code';
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
      selector: node.id
        ? `#${cssEscape(node.id)}`
        : testId
          ? `[data-testid="${cssEscape(testId)}"]`
          : undefined,
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
  const key = Object.keys(el).find(
    (name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'),
  );
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
    const path =
      node.getAttribute('data-inspector-relative-path') ||
      node.getAttribute('data-source-file') ||
      node.getAttribute('data-sourcefile') ||
      node.getAttribute('data-source');
    if (path) {
      return {
        component:
          node.getAttribute('data-component') || node.getAttribute('data-testid') || undefined,
        file: normalizeFile(path),
        line: numberOr(
          node.getAttribute('data-inspector-line') || node.getAttribute('data-source-line'),
        ),
        column: numberOr(
          node.getAttribute('data-inspector-column') || node.getAttribute('data-source-column'),
        ),
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
    'position:fixed',
    'z-index:2147483645',
    'pointer-events:none',
    'border:2px solid #ff8a2a',
    'border-radius:4px',
    'box-shadow:0 0 0 1px rgba(0,0,0,.35)',
    'display:block',
  ]);
  const pin = element('div', [
    'position:fixed',
    'z-index:2147483645',
    'pointer-events:none',
    'min-width:18px',
    'height:18px',
    'padding:0 5px',
    'border-radius:9px',
    'background:#ff8a2a',
    'color:#111',
    'font:11px ui-monospace,SFMono-Regular,Menlo,monospace',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'box-shadow:0 4px 12px rgba(0,0,0,.4)',
  ]);
  outline.setAttribute(INTERNAL_ATTR, '1');
  pin.setAttribute(INTERNAL_ATTR, '1');
  pin.textContent = '1';
  mount();
  designRoot.append(outline, pin);
  annotations.push({ anchor, el, outline, pin });
  repositionAnnotations();
}

function clearAnnotations() {
  for (const item of annotations) {
    item.outline.remove();
    item.pin.remove();
  }
  annotations = [];
  clearStrokes();
  clearTextHighlights();
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
    const box = item.el
      ? rect
      : {
          x: item.anchor.box.x,
          y: item.anchor.box.y,
          width: item.anchor.box.width,
          height: item.anchor.box.height,
        };
    const visible = designMode && box.width > 0 && box.height > 0;
    item.outline.style.display = visible ? 'block' : 'none';
    item.pin.style.display = visible ? 'flex' : 'none';
    if (!visible) continue;
    positionBox(item.outline, box);
    item.pin.style.left = `${Math.round(box.x)}px`;
    item.pin.style.top = `${Math.round(Math.max(2, box.y - 20))}px`;
  }
}

function positionBox(node, box) {
  node.style.left = `${Math.round(box.x)}px`;
  node.style.top = `${Math.round(box.y)}px`;
  node.style.width = `${Math.round(box.width)}px`;
  node.style.height = `${Math.round(box.height)}px`;
}

function showBox(rect, text) {
  mount();
  overlay.style.display = 'block';
  positionBox(overlay, rect);
  label.style.display = 'block';
  label.textContent = text;
  label.style.left = `${Math.min(window.innerWidth - 16, Math.max(8, Math.round(rect.x)))}px`;
  label.style.top = `${Math.min(window.innerHeight - 36, Math.max(8, Math.round(rect.y - 38)))}px`;
}

function hideBox() {
  overlay.style.display = 'none';
  label.style.display = 'none';
}

// Append one <path> per stroke and only mutate the active path's `d` as the
// pointer moves. Rebuilding the whole SVG each frame made the pane flicker.
function appendStrokePath(stroke) {
  mount();
  penSvg.style.display = 'block';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', PENCIL_COLOR);
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', strokePathData(stroke));
  penSvg.appendChild(path);
  strokePaths.push(path);
  return path;
}

function extendActiveStroke() {
  if (activePath && activeStroke) activePath.setAttribute('d', strokePathData(activeStroke));
}

function strokePathData(stroke) {
  return stroke
    .map((pt, index) => `${index === 0 ? 'M' : 'L'}${Math.round(pt.x)} ${Math.round(pt.y)}`)
    .join(' ');
}

function strokeLength(stroke) {
  if (!stroke || stroke.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < stroke.length; index += 1) {
    total += Math.hypot(
      stroke[index].x - stroke[index - 1].x,
      stroke[index].y - stroke[index - 1].y,
    );
  }
  return total;
}

function strokesBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const pt of stroke) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
  }
  if (!Number.isFinite(minX) || maxX - minX < 4 || maxY - minY < 4) return null;
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };
}

function clearStrokes() {
  strokes = [];
  strokePaths = [];
  activeStroke = null;
  activePath = null;
  penSvg.textContent = '';
  penSvg.style.display = 'none';
}

function labelFor(el) {
  const tag = el.tagName.toLowerCase();
  const source = resolveSource(el);
  const text = cleanText(
    el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      directText(el) ||
      el.id ||
      el.innerText ||
      el.textContent ||
      '',
    40,
  );
  const head = labelText(tag, source, text);
  if (source && source.file) {
    return `${head}  ${source.file}${source.line ? `:${source.line}` : ''}`;
  }
  return `${head}${altHeld ? '' : '  (alt: parent, shift-drag: text)'}`;
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
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function roleFor(el) {
  return (
    el.getAttribute('role') ||
    { A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' }[
      el.tagName
    ] ||
    ''
  );
}

function directText(el) {
  return cleanText(
    Array.from(el.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || '')
      .join(' '),
  );
}

function cleanText(value, max = 180) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanPrompt(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

function stableHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1)
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
}

function promptVisible() {
  return Boolean(promptBox && promptBox.style.display === 'block');
}

function showPrompt(selection) {
  promptSelection = selection;
  mountPrompt();
  hideBox();
  if (promptTag) promptTag.textContent = selection.anchor.label || selection.anchor.id;
  promptInput.value = '';
  syncPromptSend();
  positionPrompt(selection.anchor.box);
  promptBox.style.display = 'block';
  window.setTimeout(() => promptInput.focus({ preventScroll: true }), 0);
}

function hidePrompt() {
  promptSelection = null;
  if (promptBox) promptBox.style.display = 'none';
}

// Cancel fully resets the design turn: close the composer AND wipe the
// pending selection box plus any sketch strokes / text highlights, leaving the
// pane armed for a fresh selection. Hiding the composer alone left the
// annotations on screen, which looked like the cancel button did nothing.
function cancelDesign() {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  capturePending = false;
  pendingCaptureId = null;
  hidePrompt();
  hideBox();
  clearAnnotations();
}

function mountPrompt() {
  if (!promptBox) {
    promptBox = element('form', [
      'position:fixed',
      'z-index:2147483647',
      'display:none',
      'width:min(440px,calc(100vw - 24px))',
      'background:rgba(18,18,18,.96)',
      'color:#f4f4f5',
      'border:1px solid rgba(255,255,255,.16)',
      'border-radius:12px',
      'box-shadow:0 20px 60px rgba(0,0,0,.42)',
      'font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'padding:8px',
      'box-sizing:border-box',
      'pointer-events:auto',
    ]);
    promptBox.setAttribute(INTERNAL_ATTR, '1');
    const row = element('div', ['display:flex', 'align-items:center', 'gap:8px']);
    promptTag = element('div', [
      'max-width:160px',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      'color:#9ca3af',
      'font:11px ui-monospace,SFMono-Regular,Menlo,monospace',
    ]);
    promptTag.textContent = '@ref';
    promptInput = element('input', [
      'flex:1',
      'min-width:0',
      'height:32px',
      'border:0',
      'outline:0',
      'background:transparent',
      'color:#f4f4f5',
      'font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    ]);
    promptInput.placeholder = 'Describe the change';
    promptInput.addEventListener('input', syncPromptSend);
    promptSend = element('button', [
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'width:30px',
      'height:30px',
      'border:0',
      'border-radius:999px',
      'background:#f4f4f5',
      'color:#111',
      'cursor:pointer',
      'flex:0 0 auto',
      'transition:opacity .15s ease,background .15s ease',
    ]);
    promptSend.type = 'submit';
    promptSend.title = 'Send to Droid';
    promptSend.innerHTML = sendIconSvg();
    const close = element('button', [
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'width:28px',
      'height:28px',
      'border:0',
      'border-radius:7px',
      'background:transparent',
      'color:#9ca3af',
      'cursor:pointer',
      'flex:0 0 auto',
    ]);
    close.type = 'button';
    close.title = 'Cancel';
    close.innerHTML = closeIconSvg();
    row.append(promptTag, promptInput, promptSend, close);
    promptBox.append(row);
    promptBox.addEventListener('submit', (event) => {
      event.preventDefault();
      const instruction = cleanPrompt(promptInput.value);
      if (!instruction || !promptSelection) return;
      // Hide the composer but keep strokes/highlights visible: the main
      // process captures the annotated region before acking, then the
      // 'native-browser-design-prompt-sent' handler clears everything.
      captureSeq += 1;
      const captureId = captureSeq;
      pendingCaptureId = captureId;
      capturePending = true;
      sendDesignPrompt({ selection: promptSelection, instruction, captureId });
      hidePrompt();
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => {
        if (pendingCaptureId === captureId) finishCapture();
      }, 4000);
    });
    promptBox.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelDesign();
      }
    });
    close.addEventListener('click', cancelDesign);
    for (const type of ['mousedown', 'mouseup', 'click', 'mousemove', 'wheel']) {
      promptBox.addEventListener(type, (event) => event.stopPropagation(), true);
    }
  }
  mount();
  if (!promptBox.isConnected) designRoot.appendChild(promptBox);
}

function syncPromptSend() {
  if (!promptSend || !promptInput) return;
  const ready = Boolean(cleanPrompt(promptInput.value));
  promptSend.disabled = !ready;
  promptSend.style.opacity = ready ? '1' : '0.35';
  promptSend.style.cursor = ready ? 'pointer' : 'not-allowed';
}

function sendIconSvg() {
  return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
}

function closeIconSvg() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
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
  return Boolean(
    event.target && event.target.closest && event.target.closest(`[${INTERNAL_ATTR}]`),
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
