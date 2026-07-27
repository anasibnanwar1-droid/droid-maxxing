// Generic, sidecar-wide value coercion guards. Several parsing paths
// (SessionManager, history, browser/domSnapshot) need the same strict
// string/number extraction from untyped JSON; centralizing it keeps the
// behavior from silently diverging across copies. Catalog parsers
// (modelCatalog, DroidCliCatalog) intentionally use looser coercion and
// keep their own variants.
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
