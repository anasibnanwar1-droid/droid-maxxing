import assert from 'node:assert/strict';
import test from 'node:test';
import {
  colorDistance,
  compositeColor,
  nearestPaletteColor,
  nearestScaleValue,
  parseColor,
  parsePx,
  parseTokens,
  serializeTokenBlock,
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
  assert.equal(parseTokens('```design-tokens\n[]\n```'), undefined);
  assert.equal(parseTokens('```design-tokens\nnull\n```'), undefined);
});

test('serializeTokenBlock round-trips notes containing a triple backtick', () => {
  const withFence: DesignTokens = {
    ...sampleTokens,
    allowlist: [{ selector: '.demo', note: 'Example: ```css' }],
  };
  const serialized = serializeTokenBlock(withFence);
  assert.ok(serialized.startsWith('````design-tokens'));
  assert.deepEqual(parseTokens(serialized)?.allowlist, withFence.allowlist);
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

test('parseTokens keeps only actionable string allowlist rules', () => {
  const markdown = [
    '```design-tokens',
    JSON.stringify({
      allowlist: [
        null,
        {},
        { note: 'legacy' },
        { selector: ' .chart ', note: 'intentional vendor output' },
        { property: 'color', value: '#3366ff' },
        { selector: 42, property: false },
      ],
    }),
    '```',
  ].join('\n');
  assert.deepEqual(parseTokens(markdown)?.allowlist, [
    { selector: '.chart', note: 'intentional vendor output' },
    { property: 'color', value: '#3366ff' },
  ]);
});

test('parseColor handles hex, rgb and named colors', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('#0d0d0f'), [13, 13, 15, 1]);
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), [10, 20, 30, 1]);
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), [10, 20, 30, 0.5]);
  assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0]);
  assert.deepEqual(parseColor('rebeccapurple'), [102, 51, 153, 1]);
  assert.deepEqual(parseColor('hsl(0 100% 50% / 50%)'), [255, 0, 0, 0.5]);
  assert.equal(parseColor('#1z3456'), undefined);
  assert.equal(parseColor('bogus(1)'), undefined);
});

test('parseColor accepts percentage RGB and clamps computed CSS channels', () => {
  assert.deepEqual(parseColor('rgb(100% 0% 50%)'), [255, 0, 127.5, 1]);
  assert.deepEqual(parseColor('rgba(300 -20 64 / 150%)'), [255, 0, 64, 1]);
  assert.deepEqual(parseColor('hsl(0 200% -10% / -1)'), [0, 0, 0, 0]);
});

test('compositeColor resolves translucent colors against their rendered surface', () => {
  assert.deepEqual(compositeColor([0, 0, 0, 0.5], [255, 255, 255, 1]), [127.5, 127.5, 127.5, 1]);
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
