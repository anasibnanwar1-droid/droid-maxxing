import assert from 'node:assert/strict';
import test from 'node:test';
import {
  colorDistance,
  nearestPaletteColor,
  nearestScaleValue,
  parseColor,
  parsePx,
  parseTokens,
  serializeTokenBlock,
  upsertTokenBlock,
} from './tokens.js';
import type { DesignTokens } from './types.js';

const sampleTokens: DesignTokens = {
  colors: { bg: '#0d0d0f', accent: '#e0653a' },
  fonts: { sans: 'Inter, sans-serif' },
  typeScale: [12, 14, 16, 20],
  spacing: [4, 8, 12, 16],
  radii: [6, 10],
};

test('parseTokens reads a fenced design-tokens block', () => {
  const markdown = `# DNA\n\n${serializeTokenBlock(sampleTokens)}\n`;
  const tokens = parseTokens(markdown);
  assert.ok(tokens);
  assert.equal(tokens.colors.accent, '#e0653a');
  assert.deepEqual(tokens.typeScale, [12, 14, 16, 20]);
  assert.equal(tokens.fonts.sans, 'Inter, sans-serif');
});

test('parseTokens ignores malformed blocks and missing blocks', () => {
  assert.equal(parseTokens('# no tokens here'), undefined);
  assert.equal(parseTokens('```design-tokens\n{not json}\n```'), undefined);
});

test('parseTokens drops non-string colors and non-numeric scale values', () => {
  const markdown = [
    '```design-tokens',
    JSON.stringify({ colors: { ok: '#fff', bad: 3 }, typeScale: [12, 'x', null, 16] }),
    '```',
  ].join('\n');
  const tokens = parseTokens(markdown);
  assert.ok(tokens);
  assert.deepEqual(Object.keys(tokens.colors), ['ok']);
  assert.deepEqual(tokens.typeScale, [12, 16]);
});

test('upsertTokenBlock replaces an existing block in place', () => {
  const original = `# DNA\n\n## Tokens\n\n${serializeTokenBlock(sampleTokens)}\n`;
  const next = { ...sampleTokens, colors: { bg: '#111111' } };
  const updated = upsertTokenBlock(original, next);
  assert.equal(updated.match(/```design-tokens/g)?.length, 1);
  assert.ok(updated.includes('#111111'));
  assert.ok(!updated.includes('#e0653a'));
});

test('upsertTokenBlock appends a Tokens section when absent', () => {
  const updated = upsertTokenBlock('# DNA', sampleTokens);
  assert.ok(updated.includes('## Tokens'));
  assert.deepEqual(parseTokens(updated)?.colors, sampleTokens.colors);
});

test('parseColor handles hex, rgb and named colors', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('#0d0d0f'), [13, 13, 15, 1]);
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30, 1]);
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30, 0.5]);
  assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0]);
  assert.equal(parseColor('bogus(1)'), undefined);
});

test('colorDistance is zero for identical colors', () => {
  assert.equal(colorDistance([1, 2, 3, 1], [1, 2, 3, 1]), 0);
});

test('nearestPaletteColor picks the closest token', () => {
  const match = nearestPaletteColor('#e0653b', sampleTokens.colors);
  assert.equal(match?.name, 'accent');
  assert.ok((match?.distance ?? Infinity) < 2);
});

test('nearestPaletteColor treats fully transparent values as allowed', () => {
  const match = nearestPaletteColor('rgba(0, 0, 0, 0)', sampleTokens.colors);
  assert.deepEqual(match, { name: 'transparent', value: 'transparent', distance: 0 });
});

test('nearestScaleValue and parsePx handle scale lookups', () => {
  assert.equal(nearestScaleValue(15, [12, 14, 16]), 14);
  assert.equal(nearestScaleValue(19, [12, 14, 16, 20]), 20);
  assert.equal(nearestScaleValue(1, []), undefined);
  assert.equal(parsePx('13.5px'), 13.5);
  assert.equal(parsePx('1rem'), undefined);
});
