import type { BrowserElementRef, BrowserSnapshot } from './types.js';

import { numberValue, stringValue } from '../values.js';

export function normalizeSnapshot(value: unknown): BrowserSnapshot {
  const object = record(value);
  return {
    url: stringValue(object.url) ?? 'about:blank',
    title: stringValue(object.title),
    scroll: normalizeScroll(object.scroll),
    refs: arrayValue(object.refs)
      .map(normalizeElementRef)
      .filter((ref): ref is BrowserElementRef => Boolean(ref)),
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
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    return null;
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
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringRecord(value: unknown): Record<string, string> {
  const object = record(value);
  return Object.fromEntries(
    Object.entries(object).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
