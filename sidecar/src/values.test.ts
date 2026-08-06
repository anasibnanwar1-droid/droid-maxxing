import test from 'node:test';
import assert from 'node:assert/strict';
import { safeStringify } from './values.js';

test('safeStringify always returns a string, including for undefined input', () => {
  // Regression: JSON.stringify(undefined) returns undefined, which violated
  // the `: string` contract and made stringifyToolResult feed undefined to
  // trimText, crashing the line parse and dropping the whole tool_result row.
  assert.equal(safeStringify(undefined), '');
  assert.equal(typeof safeStringify(undefined), 'string');
});

test('safeStringify renders normal JSON values as pretty strings', () => {
  assert.equal(safeStringify('hi'), '"hi"');
  assert.equal(safeStringify(42), '42');
  assert.equal(safeStringify(null), 'null');
  assert.equal(safeStringify({ a: 1 }), '{\n  "a": 1\n}');
});

test('safeStringify falls back to String() for unstringifiable values', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  // JSON.stringify throws on cycles; the catch must still return a string.
  assert.equal(typeof safeStringify(cyclic), 'string');
});
