import type { DesignTokens } from './types.js';

// DESIGN.md carries a fenced `design-tokens` JSON block so agents and the
// validator read the same source of truth as humans.
const TOKEN_BLOCK = /```design-tokens\s*\n([\s\S]*?)```/;

export function parseTokens(markdown: string): DesignTokens | undefined {
  const match = TOKEN_BLOCK.exec(markdown);
  if (!match) return undefined;
  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>;
    return normalizeTokens(raw);
  } catch {
    return undefined;
  }
}

export function serializeTokenBlock(tokens: DesignTokens): string {
  return '```design-tokens\n' + JSON.stringify(tokens, null, 2) + '\n```';
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

const NAMED_COLORS: Record<string, Rgba> = {
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
  transparent: [0, 0, 0, 0],
};

export function parseColor(value: string): Rgba | undefined {
  const input = value.trim().toLowerCase();
  if (input in NAMED_COLORS) return NAMED_COLORS[input];
  if (input.startsWith('#')) return parseHex(input);
  const fn = /^(rgb|rgba)\(([^)]+)\)$/.exec(input);
  if (fn) {
    const parts = fn[2]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return undefined;
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  }
  return undefined;
}

function parseHex(input: string): Rgba | undefined {
  const hex = input.slice(1);
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
