import { useCallback, useRef, useState } from 'react';

// Serializes async UI actions. The `busy` state drives disabled/spinner UI,
// while the ref guards synchronously: state only updates on the next render,
// so a same-tick second trigger (e.g. Enter on an input that isn't disabled)
// would slip past a state-only check and launch a duplicate git operation.
export function useBusyAction() {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, run };
}
