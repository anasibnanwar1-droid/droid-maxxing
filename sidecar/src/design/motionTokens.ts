import type { MotionDuration, MotionTokens } from './types.js';

const MOTION_BLOCK = /```motion-tokens\s*\n([\s\S]*?)```/;

/** Parse the executable motion contract stored in MOTION.md. */
export function parseMotionTokens(markdown: string): MotionTokens | undefined {
  const match = MOTION_BLOCK.exec(markdown);
  if (!match) return undefined;

  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>;
    if (!isRecord(raw.durations) || !isRecord(raw.easings)) return undefined;
    if (raw.reducedMotion !== 'disable' && raw.reducedMotion !== 'reduce') return undefined;

    const durations: Record<string, MotionDuration> = {};
    for (const [name, value] of Object.entries(raw.durations)) {
      const duration = normalizeDuration(value);
      if (duration !== undefined) durations[name] = duration;
    }

    const easings: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw.easings)) {
      if (typeof value === 'string') {
        const easing = value.trim();
        if (isCssEasing(easing)) easings[name] = easing;
      }
    }

    if (Object.keys(durations).length === 0 || Object.keys(easings).length === 0) return undefined;

    const pressScale =
      typeof raw.pressScale === 'number' && raw.pressScale >= 0.5 && raw.pressScale <= 1
        ? raw.pressScale
        : undefined;

    return {
      durations,
      easings,
      ...(pressScale === undefined ? {} : { pressScale }),
      reducedMotion: raw.reducedMotion,
    };
  } catch {
    return undefined;
  }
}

export function serializeMotionTokenBlock(tokens: MotionTokens): string {
  return '```motion-tokens\n' + JSON.stringify(tokens, null, 2) + '\n```';
}

function normalizeDuration(value: unknown): MotionDuration | undefined {
  if (isDuration(value)) return value;
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    isDuration(value[0]) &&
    isDuration(value[1]) &&
    value[0] <= value[1]
  ) {
    return [value[0], value[1]];
  }
  return undefined;
}

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCssEasing(value: string): boolean {
  const input = value.trim();
  if (/^(linear|ease|ease-in|ease-out|ease-in-out)$/.test(input)) return true;
  const bezier =
    /^cubic-bezier\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)$/.exec(
      input,
    );
  if (!bezier) return false;
  const coordinates = bezier.slice(1).map(Number);
  const [x1, , x2] = coordinates;
  return coordinates.every(Number.isFinite) && x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1;
}
