// Poll results are freshly deserialized every cycle; keep the previous object
// when the payload is unchanged so consumers' memo/effect deps stay stable and
// an idle repo doesn't cascade re-renders on every poll. The serialized
// signature is memoized per object (WeakMap), so a retained previous value is
// stringified once, not once per comparison per cycle.
const signatures = new WeakMap<object, string>();

function signatureOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return `${JSON.stringify(value)}`;
  let sig = signatures.get(value);
  if (sig === undefined) {
    sig = JSON.stringify(value);
    signatures.set(value, sig);
  }
  return sig;
}

export function stable<T>(prev: T, next: T): T {
  return signatureOf(prev) === signatureOf(next) ? prev : next;
}
