import { diffPaletteForTheme } from './diffTheme';

// The five colors every theme is built from; applyTheme derives the rest of
// the ramp (elevated/active/borders/secondary/muted/shadow) from these.
export interface ThemeColors {
  bg: string;
  fg: string;
  surface: string;
  border: string;
  accent: string;
}

export type ThemeMode = 'dark' | 'light' | 'system';

// Structural view of the persisted theme that applyTheme needs. Matches
// ThemeConfig in useStore without importing it (store -> theme one-way dep).
export interface ThemeSettings extends ThemeColors {
  diffStyle: 'soft' | 'focused';
  uiFont: string;
  uiFontSize: number;
  codeFontSize: number;
  translucentSidebar: boolean;
  contrast: number;
}

// Each preset carries a theme-matched neutral accent so switching mode/preset
// keeps the UI monochrome (the accent tracks the foreground tone) instead of
// leaving a stale colored accent behind. Tinted themes (midnight/warm) use
// their own fg tone as the accent so they stay on a single tonal scale.
//
// Light is deliberately NOT white-on-white: a warm grey canvas with pure-white
// surfaces gives the same tonal depth dark mode has (cards and hover states
// stay visible), keeps near-black text from glaring, and lets the pastel diff
// palettes read. Pure-white backgrounds are tiring and flatten every border.
export const PRESET_THEMES: Record<string, ThemeColors> = {
  dark: { bg: '#0a0a0a', fg: '#ededed', surface: '#111111', border: '#1f1f1f', accent: '#f2f2f2' },
  light: { bg: '#e9e7e4', fg: '#262521', surface: '#ffffff', border: '#ddd9d4', accent: '#1c1b18' },
  midnight: {
    bg: '#0a0e1a',
    fg: '#c8d0e0',
    surface: '#11152a',
    border: '#1a2040',
    accent: '#c8d0e0',
  },
  warm: { bg: '#1a1612', fg: '#d8d0c8', surface: '#221e18', border: '#322a22', accent: '#d8d0c8' },
};

// The light preset as it shipped before the readability pass. A saved theme
// still carrying all five legacy values was never customized, so it is swapped
// to the new preset once on load (see useStore loadTheme).
const LEGACY_LIGHT_PRESET: ThemeColors = {
  bg: '#fcfcfc',
  fg: '#141414',
  surface: '#f3f3f3',
  border: '#eeeeee',
  accent: '#1a1a1a',
};

export function migrateLegacyLightPreset(colors: ThemeColors): ThemeColors {
  const isLegacy = (Object.keys(LEGACY_LIGHT_PRESET) as (keyof ThemeColors)[]).every(
    (key) => colors[key].toLowerCase() === LEGACY_LIGHT_PRESET[key],
  );
  return isLegacy ? { ...PRESET_THEMES.light } : colors;
}

const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const UI_FONTS: { id: string; label: string; stack: string }[] = [
  { id: 'system', label: 'System', stack: SYSTEM_FONT_STACK },
  { id: 'inter', label: 'Inter', stack: `"Inter", ${SYSTEM_FONT_STACK}` },
  { id: 'sf', label: 'SF Pro', stack: `"SF Pro Display", "SF Pro Text", ${SYSTEM_FONT_STACK}` },
  { id: 'geist', label: 'Geist', stack: `"Geist", ${SYSTEM_FONT_STACK}` },
  { id: 'helvetica', label: 'Helvetica', stack: `"Helvetica Neue", Helvetica, Arial, sans-serif` },
  { id: 'georgia', label: 'Georgia', stack: `Georgia, "Times New Roman", serif` },
  { id: 'mono', label: 'Mono', stack: `"JetBrains Mono", "Fira Code", ui-monospace, monospace` },
];

export function uiFontStack(id: string): string {
  return UI_FONTS.find((f) => f.id === id)?.stack ?? SYSTEM_FONT_STACK;
}

// Base palette for a theme mode. `system` follows the OS preference.
export function paletteForMode(mode: ThemeMode): ThemeColors {
  const isLight =
    mode === 'light' ||
    (mode === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  return isLight ? PRESET_THEMES.light : PRESET_THEMES.dark;
}

/* ── apply CSS variables to document ── */
export function applyTheme(theme: ThemeSettings) {
  const root = document.documentElement;
  root.style.setProperty('--droid-bg', theme.bg);
  root.style.setProperty('--droid-surface', theme.surface);
  // Build the elevation ramp in the correct direction for the theme. Dark themes
  // get lighter as surfaces rise (bg < surface < elevated < active); light themes
  // step progressively darker, since there is no headroom above a near-white base
  // (e.g. surface #f3f3f3 over bg #fcfcfc). This keeps a real, visible tonal
  // hierarchy in both modes instead of an inverted/flat ramp.
  const bgIsDark = colorLuminance(theme.bg) < 0.4;
  const lift = (amount: number) => adjustColor(theme.surface, bgIsDark ? amount : -amount);
  root.style.setProperty('--droid-elevated', lift(13));
  // Input fields inside cards: lifted like elevated on dark (reads as a raised
  // pad), plain surface on light so fields stay crisp on the tinted card
  // instead of stepping darker into a grey smudge.
  root.style.setProperty('--droid-field', bgIsDark ? lift(13) : theme.surface);
  // The most-raised neutral, for selected/active rows.
  root.style.setProperty('--droid-active', lift(26));
  // Soften resting borders by blending toward the background so panel/section
  // separators read as gentle hairlines rather than hard lines. Dark themes need
  // a stronger blend: at low luminance the same edge reads as a harsh outline, so
  // we push it closer to the background to keep the subtle look light mode has.
  root.style.setProperty('--droid-border', mixHex(theme.border, theme.bg, bgIsDark ? 0.72 : 0.6));
  root.style.setProperty(
    '--droid-border-hover',
    mixHex(theme.border, theme.bg, bgIsDark ? 0.4 : 0.2),
  );
  root.style.setProperty('--droid-text', theme.fg);
  if (bgIsDark) {
    root.style.setProperty('--droid-text-secondary', adjustColor(theme.fg, -30));
    root.style.setProperty('--droid-text-muted', adjustColor(theme.fg, -50));
  } else {
    // Light themes have no dark headroom below a near-black fg (darkening would
    // invert the hierarchy into pure black), so mute by blending toward the
    // canvas: secondary ~4.4:1 on white, muted reserved for placeholders.
    root.style.setProperty('--droid-text-secondary', mixHex(theme.fg, theme.bg, 0.42));
    root.style.setProperty('--droid-text-muted', mixHex(theme.fg, theme.bg, 0.62));
  }
  root.style.setProperty('--droid-accent', theme.accent);
  // Floating-card shadow: strong and near-black on dark where it separates
  // surfaces, soft and diffuse on light so cards lift without looking dirty.
  root.style.setProperty(
    '--droid-shadow',
    bgIsDark ? '0 10px 40px rgba(0, 0, 0, 0.35)' : '0 10px 30px rgba(28, 25, 23, 0.1)',
  );
  // Semantic status colors are FIXED, never accent-derived, so success/warning
  // and diff add/remove always read as green/amber/red even when the accent is a
  // neutral monochrome tone.
  root.style.setProperty('--droid-green', '#4fae82');
  root.style.setProperty('--droid-orange', '#d9913a');
  root.style.setProperty('--droid-red', '#cf5d54');
  root.setAttribute('data-diff-style', theme.diffStyle);
  const diffPalette = diffPaletteForTheme(bgIsDark, theme.diffStyle);
  root.style.setProperty('--diff-add-fg', diffPalette.addFg);
  root.style.setProperty('--diff-add-bg', diffPalette.addBg);
  root.style.setProperty('--diff-add-gutter', diffPalette.addGutter);
  root.style.setProperty('--diff-del-fg', diffPalette.delFg);
  root.style.setProperty('--diff-del-bg', diffPalette.delBg);
  root.style.setProperty('--diff-del-gutter', diffPalette.delGutter);
  root.style.setProperty('--diff-hunk-bg', diffPalette.hunkBg);
  root.style.setProperty('--diff-hunk-fg', diffPalette.hunkFg);

  root.style.setProperty('--ui-font-family', uiFontStack(theme.uiFont));
  root.style.setProperty('--ui-font-size', `${String(theme.uiFontSize)}px`);
  // The UI is built with fixed px text sizes, so scale the whole app relative
  // to the 14px baseline to make the size slider take visible effect.
  root.style.setProperty('--ui-zoom', String(theme.uiFontSize / 14));
  root.style.setProperty('--code-font-size', `${String(theme.codeFontSize)}px`);

  // Dedicated sidebar surface so translucency only affects the sidebar. When
  // enabled, the window becomes transparent (see index.css + Electron vibrancy)
  // and the sidebar uses a semi-transparent fill so the wallpaper behind the
  // window shows through a little — frosted, not fully clear.
  // Light surfaces sit over a dark macOS vibrancy material, so a low-opacity
  // fill plus a strong saturation boost lets the wallpaper bleed through as a
  // muddy tint. Keep light themes mostly opaque with gentle saturation so the
  // sidebar stays a clean frosted white; dark themes can show more through.
  root.setAttribute('data-translucent', theme.translucentSidebar ? 'true' : 'false');
  const sidebarAlpha = bgIsDark ? '99' : 'f2';
  const sidebarSaturate = bgIsDark ? 'saturate(150%)' : 'saturate(108%)';
  root.style.setProperty(
    '--sidebar-bg',
    theme.translucentSidebar ? `${theme.surface}${sidebarAlpha}` : theme.surface,
  );
  root.style.setProperty(
    '--sidebar-blur',
    theme.translucentSidebar ? `blur(6px) ${sidebarSaturate}` : 'none',
  );

  // Apply contrast as a filter only below 100% so it never creates a stacking
  // context that would defeat the sidebar's backdrop blur at the default value.
  const rootEl = document.getElementById('root');
  if (rootEl)
    rootEl.style.filter = theme.contrast >= 100 ? '' : `contrast(${String(theme.contrast)}%)`;
}

/* ── tiny color utils ── */
// Relative luminance (0 = black, 1 = white) used to tell dark themes from light.
function colorLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function adjustColor(hex: string, lighten: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const clamp = (n: number) => Math.max(0, Math.min(255, n + lighten));
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(clamp(r))}${toHex(clamp(g))}${toHex(clamp(b))}`;
}

// Blend `hex` toward `target` by t (0..1).
function mixHex(hex: string, target: string, t: number): string {
  const parse = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(hex);
  const [r2, g2, b2] = parse(target);
  const mix = (a: number, b: number) => Math.round(a * (1 - t) + b * t);
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toHex(mix(r1, r2))}${toHex(mix(g1, g2))}${toHex(mix(b1, b2))}`;
}
