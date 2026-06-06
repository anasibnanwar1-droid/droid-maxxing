import type { BrowserElementRef, BrowserSnapshot } from './types.js';

export const DOM_SNAPSHOT_SCRIPT = String.raw`
(() => {
  const MARKABLE_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '[role]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  const STYLE_KEYS = [
    'color',
    'backgroundColor',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'border',
    'borderRadius',
    'display',
    'position',
    'opacity',
    'transform'
  ];
  const attrKeys = ['id', 'name', 'type', 'role', 'aria-label', 'title', 'placeholder', 'data-testid'];
  const isVisible = (el, box) => {
    if (box.width <= 0 || box.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0;
  };
  const textFor = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const attrsFor = (el) => Object.fromEntries(attrKeys.flatMap((key) => {
    const value = el.getAttribute(key);
    return value ? [[key, value]] : [];
  }));
  const cssEscape = (value) => {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, '\\$&');
  };
  const selectorFor = (el) => {
    if (el.id) return '#' + cssEscape(el.id);
    const testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + cssEscape(testId) + '"]';
    const label = el.getAttribute('aria-label');
    if (label) return el.tagName.toLowerCase() + '[aria-label="' + cssEscape(label) + '"]';
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const roleFor = (el) => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' })[el.tagName] || undefined;
  const nameFor = (el, attrs, text) => attrs['aria-label'] || attrs.title || attrs.placeholder || attrs.name || text || undefined;
  const elements = Array.from(document.querySelectorAll(MARKABLE_SELECTOR));
  const refs = [];
  for (const el of elements) {
    if (refs.length >= 80) break;
    const rect = el.getBoundingClientRect();
    const box = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    if (!isVisible(el, box)) continue;
    const attrs = attrsFor(el);
    const text = textFor(el);
    const styles = window.getComputedStyle(el);
    refs.push({
      ref: '@e' + (refs.length + 1),
      selector: selectorFor(el),
      tagName: el.tagName.toLowerCase(),
      role: roleFor(el),
      name: nameFor(el, attrs, text),
      text,
      attributes: attrs,
      className: typeof el.className === 'string' ? el.className.slice(0, 160) : '',
      box,
      computedStyles: Object.fromEntries(STYLE_KEYS.map((key) => [key, styles[key] || '']))
    });
  }
  return {
    url: location.href,
    title: document.title,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    refs
  };
})()
`;

export function normalizeSnapshot(value: unknown): BrowserSnapshot {
  const object = record(value);
  return {
    url: stringValue(object.url) ?? 'about:blank',
    title: stringValue(object.title),
    scroll: normalizeScroll(object.scroll),
    refs: arrayValue(object.refs).map(normalizeElementRef).filter((ref): ref is BrowserElementRef => Boolean(ref)),
  };
}

function normalizeElementRef(value: unknown): BrowserElementRef | null {
  const object = record(value);
  const ref = stringValue(object.ref);
  const selector = stringValue(object.selector);
  const tagName = stringValue(object.tagName);
  const box = normalizeBox(object.box);
  if (!ref || !selector || !tagName || !box) return null;
  return {
    ref,
    selector,
    tagName,
    role: stringValue(object.role),
    name: stringValue(object.name),
    text: stringValue(object.text),
    attributes: stringRecord(object.attributes),
    className: stringValue(object.className),
    box,
    computedStyles: stringRecord(object.computedStyles),
  };
}

function normalizeBox(value: unknown): BrowserElementRef['box'] | null {
  const object = record(value);
  const x = numberValue(object.x);
  const y = numberValue(object.y);
  const width = numberValue(object.width);
  const height = numberValue(object.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return null;
  return { x, y, width, height };
}

function normalizeScroll(value: unknown): BrowserSnapshot['scroll'] {
  const object = record(value);
  return {
    x: numberValue(object.x) ?? 0,
    y: numberValue(object.y) ?? 0,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringRecord(value: unknown): Record<string, string> {
  const object = record(value);
  return Object.fromEntries(
    Object.entries(object).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
