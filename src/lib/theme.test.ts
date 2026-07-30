import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESET_THEMES,
  migrateLegacyLightPreset,
  paletteForMode,
  uiFontStack,
  type ThemeColors,
} from './theme';

const LEGACY_LIGHT: ThemeColors = {
  bg: '#fcfcfc',
  fg: '#141414',
  surface: '#f3f3f3',
  border: '#eeeeee',
  accent: '#1a1a1a',
};

describe('PRESET_THEMES', () => {
  it('keeps every preset on valid 6-digit hex colors', () => {
    for (const colors of Object.values(PRESET_THEMES)) {
      for (const value of Object.values(colors)) {
        assert.match(value, /^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('light canvas is grey (not near-white) with white surfaces above it', () => {
    const { bg, surface } = PRESET_THEMES.light;
    const lum = (hex: string) =>
      (0.2126 * parseInt(hex.slice(1, 3), 16) +
        0.7152 * parseInt(hex.slice(3, 5), 16) +
        0.0722 * parseInt(hex.slice(5, 7), 16)) /
      255;
    assert.ok(lum(bg) < 0.92, `light bg ${bg} should sit below searing white`);
    assert.ok(lum(surface) > lum(bg), 'surfaces must lift above the canvas');
  });
});

describe('migrateLegacyLightPreset', () => {
  it('swaps an exact legacy light theme to the new preset', () => {
    assert.deepEqual(migrateLegacyLightPreset({ ...LEGACY_LIGHT }), PRESET_THEMES.light);
  });

  it('matches legacy values case-insensitively', () => {
    assert.deepEqual(
      migrateLegacyLightPreset({ ...LEGACY_LIGHT, bg: '#FCFCFC' }),
      PRESET_THEMES.light,
    );
  });

  it('leaves a customized light theme untouched (same reference)', () => {
    const custom = { ...LEGACY_LIGHT, accent: '#ee6018' };
    assert.equal(migrateLegacyLightPreset(custom), custom);
  });

  it('leaves non-light themes untouched', () => {
    assert.equal(migrateLegacyLightPreset(PRESET_THEMES.dark), PRESET_THEMES.dark);
  });
});

describe('paletteForMode', () => {
  it('returns the matching preset for explicit modes', () => {
    assert.equal(paletteForMode('light'), PRESET_THEMES.light);
    assert.equal(paletteForMode('dark'), PRESET_THEMES.dark);
  });
});

describe('uiFontStack', () => {
  it('falls back to the system stack for unknown ids', () => {
    assert.match(uiFontStack('nope'), /system-ui/);
  });
});
