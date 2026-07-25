import assert from 'node:assert/strict';
import test from 'node:test';
import { diffPaletteForTheme } from './diffTheme';

test('diff palettes use distinct readable semantic colors in light and dark themes', () => {
  const light = diffPaletteForTheme(false, 'soft');
  const dark = diffPaletteForTheme(true, 'soft');

  assert.equal(light.addFg, '#1a7f37');
  assert.equal(light.delFg, '#cf222e');
  assert.notEqual(light.addBg, light.delBg);
  assert.notEqual(dark.addFg, light.addFg);
  assert.notEqual(dark.delFg, light.delFg);
});

test('focused diff palettes strengthen changed rows and gutters', () => {
  const soft = diffPaletteForTheme(false, 'soft');
  const focused = diffPaletteForTheme(false, 'focused');

  assert.notEqual(focused.addBg, soft.addBg);
  assert.notEqual(focused.delBg, soft.delBg);
  assert.notEqual(focused.addGutter, focused.addBg);
  assert.notEqual(focused.delGutter, focused.delBg);
});
