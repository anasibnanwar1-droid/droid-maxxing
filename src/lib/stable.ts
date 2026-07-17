// Poll results are freshly deserialized every cycle; keep the previous object
// when the payload is unchanged so consumers' memo/effect deps stay stable and
// an idle repo doesn't cascade re-renders on every poll. Uses deterministic
// deep-equality (not JSON.stringify) so key-order differences in IPC payloads
// don't cause false mismatches that trigger unnecessary re-renders.

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false; // primitives already handled by ===
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  const bo = b as Record<string, unknown>;
  const ao = a as Record<string, unknown>;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

export function stable<T>(prev: T, next: T): T {
  return deepEqual(prev, next) ? prev : next;
}
