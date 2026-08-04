import type { DesignTokens } from './types.js';

// DESIGN.md carries a fenced `design-tokens` JSON block so agents and the
// validator read the same source of truth as humans.
const TOKEN_BLOCK = /(`{3,})design-tokens\s*\n([\s\S]*?)\1/;

export function parseTokens(markdown: string): DesignTokens | undefined {
  const match = TOKEN_BLOCK.exec(markdown);
  if (!match) return undefined;
  try {
    const raw: unknown = JSON.parse(match[2]);
    if (!isRecord(raw)) return undefined;
    return normalizeTokens(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function serializeTokenBlock(tokens: DesignTokens): string {
  const json = JSON.stringify(tokens, null, 2);
  const longestRun = Math.max(0, ...(json.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}design-tokens\n${json}\n${fence}`;
}

function normalizeTokens(raw: Record<string, unknown>): DesignTokens {
  const colors: Record<string, string> = {};
  if (raw.colors && typeof raw.colors === 'object') {
    for (const [key, value] of Object.entries(raw.colors as Record<string, unknown>)) {
      if (typeof value === 'string') colors[key] = value;
    }
  }
  const fonts: DesignTokens['fonts'] = {};
  if (raw.fonts && typeof raw.fonts === 'object') {
    const source = raw.fonts as Record<string, unknown>;
    for (const key of ['sans', 'mono', 'display'] as const) {
      const value = source[key];
      if (typeof value === 'string') fonts[key] = value;
    }
  }
  return {
    colors,
    fonts,
    typeScale: numberList(raw.typeScale),
    spacing: numberList(raw.spacing),
    radii: numberList(raw.radii),
    shadows: stringList(raw.shadows),
    allowlist: normalizeAllowlist(raw.allowlist),
  };
}

function normalizeAllowlist(value: unknown): DesignTokens['allowlist'] {
  if (!Array.isArray(value)) return undefined;
  const rules = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const rule: NonNullable<DesignTokens['allowlist']>[number] = {};
    for (const field of ['selector', 'property', 'value', 'note'] as const) {
      const raw = source[field];
      if (typeof raw === 'string' && raw.trim()) rule[field] = raw.trim();
    }
    return rule.selector || rule.property || rule.value ? [rule] : [];
  });
  return rules.length > 0 ? rules : undefined;
}

function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length > 0 ? items : undefined;
}

// ── Color math ───────────────────────────────────────────────────────

export type Rgba = [number, number, number, number];

const NAMED_COLOR_HEX: Record<string, string> = {
  aliceblue: 'f0f8ff',
  antiquewhite: 'faebd7',
  aqua: '00ffff',
  aquamarine: '7fffd4',
  azure: 'f0ffff',
  beige: 'f5f5dc',
  bisque: 'ffe4c4',
  black: '000000',
  blanchedalmond: 'ffebcd',
  blue: '0000ff',
  blueviolet: '8a2be2',
  brown: 'a52a2a',
  burlywood: 'deb887',
  cadetblue: '5f9ea0',
  chartreuse: '7fff00',
  chocolate: 'd2691e',
  coral: 'ff7f50',
  cornflowerblue: '6495ed',
  cornsilk: 'fff8dc',
  crimson: 'dc143c',
  cyan: '00ffff',
  darkblue: '00008b',
  darkcyan: '008b8b',
  darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9',
  darkgreen: '006400',
  darkgrey: 'a9a9a9',
  darkkhaki: 'bdb76b',
  darkmagenta: '8b008b',
  darkolivegreen: '556b2f',
  darkorange: 'ff8c00',
  darkorchid: '9932cc',
  darkred: '8b0000',
  darksalmon: 'e9967a',
  darkseagreen: '8fbc8f',
  darkslateblue: '483d8b',
  darkslategray: '2f4f4f',
  darkslategrey: '2f4f4f',
  darkturquoise: '00ced1',
  darkviolet: '9400d3',
  deeppink: 'ff1493',
  deepskyblue: '00bfff',
  dimgray: '696969',
  dimgrey: '696969',
  dodgerblue: '1e90ff',
  firebrick: 'b22222',
  floralwhite: 'fffaf0',
  forestgreen: '228b22',
  fuchsia: 'ff00ff',
  gainsboro: 'dcdcdc',
  ghostwhite: 'f8f8ff',
  gold: 'ffd700',
  goldenrod: 'daa520',
  gray: '808080',
  green: '008000',
  greenyellow: 'adff2f',
  grey: '808080',
  honeydew: 'f0fff0',
  hotpink: 'ff69b4',
  indianred: 'cd5c5c',
  indigo: '4b0082',
  ivory: 'fffff0',
  khaki: 'f0e68c',
  lavender: 'e6e6fa',
  lavenderblush: 'fff0f5',
  lawngreen: '7cfc00',
  lemonchiffon: 'fffacd',
  lightblue: 'add8e6',
  lightcoral: 'f08080',
  lightcyan: 'e0ffff',
  lightgoldenrodyellow: 'fafad2',
  lightgray: 'd3d3d3',
  lightgreen: '90ee90',
  lightgrey: 'd3d3d3',
  lightpink: 'ffb6c1',
  lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa',
  lightskyblue: '87cefa',
  lightslategray: '778899',
  lightslategrey: '778899',
  lightsteelblue: 'b0c4de',
  lightyellow: 'ffffe0',
  lime: '00ff00',
  limegreen: '32cd32',
  linen: 'faf0e6',
  magenta: 'ff00ff',
  maroon: '800000',
  mediumaquamarine: '66cdaa',
  mediumblue: '0000cd',
  mediumorchid: 'ba55d3',
  mediumpurple: '9370db',
  mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee',
  mediumspringgreen: '00fa9a',
  mediumturquoise: '48d1cc',
  mediumvioletred: 'c71585',
  midnightblue: '191970',
  mintcream: 'f5fffa',
  mistyrose: 'ffe4e1',
  moccasin: 'ffe4b5',
  navajowhite: 'ffdead',
  navy: '000080',
  oldlace: 'fdf5e6',
  olive: '808000',
  olivedrab: '6b8e23',
  orange: 'ffa500',
  orangered: 'ff4500',
  orchid: 'da70d6',
  palegoldenrod: 'eee8aa',
  palegreen: '98fb98',
  paleturquoise: 'afeeee',
  palevioletred: 'db7093',
  papayawhip: 'ffefd5',
  peachpuff: 'ffdab9',
  peru: 'cd853f',
  pink: 'ffc0cb',
  plum: 'dda0dd',
  powderblue: 'b0e0e6',
  purple: '800080',
  rebeccapurple: '663399',
  red: 'ff0000',
  rosybrown: 'bc8f8f',
  royalblue: '4169e1',
  saddlebrown: '8b4513',
  salmon: 'fa8072',
  sandybrown: 'f4a460',
  seagreen: '2e8b57',
  seashell: 'fff5ee',
  sienna: 'a0522d',
  silver: 'c0c0c0',
  skyblue: '87ceeb',
  slateblue: '6a5acd',
  slategray: '708090',
  slategrey: '708090',
  snow: 'fffafa',
  springgreen: '00ff7f',
  steelblue: '4682b4',
  tan: 'd2b48c',
  teal: '008080',
  thistle: 'd8bfd8',
  tomato: 'ff6347',
  turquoise: '40e0d0',
  violet: 'ee82ee',
  wheat: 'f5deb3',
  white: 'ffffff',
  whitesmoke: 'f5f5f5',
  yellow: 'ffff00',
  yellowgreen: '9acd32',
};

export function parseColor(value: string): Rgba | undefined {
  const input = value.trim().toLowerCase();
  if (input === 'transparent') return [0, 0, 0, 0];
  const named = NAMED_COLOR_HEX[input];
  if (named) return parseHex(`#${named}`);
  if (input.startsWith('#')) return parseHex(input);
  const fn = /^(rgb|rgba)\(([^)]+)\)$/.exec(input);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return undefined;
    const [red, green, blue] = parts.slice(0, 3).map(parseRgbChannel);
    let alpha = 1;
    if (parts.length > 3) {
      const parsedAlpha = parseAlpha(parts[3]);
      if (parsedAlpha === undefined) return undefined;
      alpha = parsedAlpha;
    }
    if (red === undefined || green === undefined || blue === undefined) {
      return undefined;
    }
    return [red, green, blue, alpha];
  }
  const hsl = /^hsla?\(([^)]+)\)$/.exec(input);
  if (hsl) return parseHsl(hsl[1]);
  return undefined;
}

function parseHex(input: string): Rgba | undefined {
  const hex = input.slice(1);
  if (!/^[0-9a-f]+$/.test(hex)) return undefined;
  if (hex.length === 3 || hex.length === 4) {
    const digits = hex.split('').map((char) => parseInt(char + char, 16));
    if (digits.some(Number.isNaN)) return undefined;
    return [digits[0], digits[1], digits[2], hex.length === 4 ? digits[3] / 255 : 1];
  }
  if (hex.length === 6 || hex.length === 8) {
    const digits = [0, 2, 4, 6]
      .slice(0, hex.length / 2)
      .map((at) => parseInt(hex.slice(at, at + 2), 16));
    if (digits.some(Number.isNaN)) return undefined;
    return [digits[0], digits[1], digits[2], hex.length === 8 ? digits[3] / 255 : 1];
  }
  return undefined;
}

function parseHsl(value: string): Rgba | undefined {
  const parts = value.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || !parts[1].endsWith('%') || !parts[2].endsWith('%')) return undefined;
  const hue = Number(parts[0]);
  const saturation = clamp(Number(parts[1].slice(0, -1)) / 100, 0, 1);
  const lightness = clamp(Number(parts[2].slice(0, -1)) / 100, 0, 1);
  const alpha = parseAlpha(parts[3] ?? '1');
  if (alpha === undefined) return undefined;
  if (![hue, saturation, lightness, alpha].every(Number.isFinite)) return undefined;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const [red, green, blue] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const offset = lightness - chroma / 2;
  return [
    Math.round((red + offset) * 255),
    Math.round((green + offset) * 255),
    Math.round((blue + offset) * 255),
    alpha,
  ];
}

function parseRgbChannel(value: string): number | undefined {
  const parsed = value.endsWith('%') ? (Number(value.slice(0, -1)) / 100) * 255 : Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 255) : undefined;
}

function parseAlpha(value: string): number | undefined {
  const parsed = value.endsWith('%') ? Number(value.slice(0, -1)) / 100 : Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function compositeColor(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha,
  ];
}

export function colorDistance(a: Rgba, b: Rgba): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

export interface PaletteMatch {
  name: string;
  value: string;
  distance: number;
}

export function nearestPaletteColor(
  actual: string,
  palette: Record<string, string>,
): PaletteMatch | undefined {
  const target = parseColor(actual);
  if (!target) return undefined;
  if (target[3] === 0) return { name: 'transparent', value: 'transparent', distance: 0 };
  let best: PaletteMatch | undefined;
  for (const [name, value] of Object.entries(palette)) {
    const candidate = parseColor(value);
    if (!candidate) continue;
    const distance = colorDistance(target, candidate);
    if (!best || distance < best.distance) best = { name, value, distance };
  }
  return best;
}

export function nearestScaleValue(actual: number, scale: number[]): number | undefined {
  if (scale.length === 0) return undefined;
  return scale.reduce((closest, value) =>
    Math.abs(value - actual) < Math.abs(closest - actual) ? value : closest,
  );
}

export function parsePx(value: string): number | undefined {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  if (!match) return undefined;
  return Number(match[1]);
}
