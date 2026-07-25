import type { Autonomy } from './protocol.js';

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function boundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeAutonomy(value: unknown): Autonomy | undefined {
  if (value === 'none') return 'off';
  if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A user Stop/interrupt makes the SDK stream throw (a cancellation message or an
// AbortError). That is a deliberate stop, not a failure, so callers must settle
// quietly instead of surfacing it as an error.
export function isUserCancellation(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError')
    return true;
  const m = errMsg(err).toLowerCase();
  return (
    m.includes('interrupted by user') ||
    m.includes('cancelled by user') ||
    m.includes('canceled by user') ||
    m.includes('request interrupted') ||
    m.includes('request cancelled') ||
    m.includes('request canceled')
  );
}
