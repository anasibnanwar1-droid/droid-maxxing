import { useEffect, useRef, useState } from 'react';
import { gitFetch } from '../lib/git';

// A fetch hits the network, so rapid open/close/reopen of a picker must not
// hammer the remote; one fetch per repo per interval is plenty for "branches
// pushed from elsewhere" freshness. Module-level so all pickers share it.
const MIN_FETCH_INTERVAL_MS = 30_000;
const lastFetchAt = new Map<string, number>();

// Best-effort `git fetch` when a branch picker opens so branches pushed from
// elsewhere appear without leaving the app. Fires once per open (not on every
// render or poll) and at most once per MIN_FETCH_INTERVAL_MS per repo, ignores
// offline/auth failures, and reports in-flight state so the caller can show a
// spinner. The callback is read through a ref so an unstable `onFetched`
// identity never re-triggers the fetch.
export function useGitFetchOnOpen(open: boolean, cwd: string, onFetched: () => void): boolean {
  const [fetching, setFetching] = useState(false);
  const cbRef = useRef(onFetched);
  cbRef.current = onFetched;

  useEffect(() => {
    if (!open || !cwd) {
      // Closing (or losing the cwd) mid-fetch must clear the in-flight flag; the
      // prior run's cleanup cancels its .then, so nothing else will reset it.
      setFetching(false);
      return;
    }
    if (Date.now() - (lastFetchAt.get(cwd) ?? 0) < MIN_FETCH_INTERVAL_MS) {
      // Under StrictMode the effect double-invokes: the first run sets fetching
      // and starts a fetch, the cleanup cancels it, and this guard early-returns
      // on the second run — leaving fetching stuck true forever. Reset it on
      // every early-return path so the spinner can never get wedged.
      setFetching(false);
      return;
    }
    // Recorded at start (not completion) so a concurrent second picker, or a
    // failing remote, can't stack parallel fetches.
    lastFetchAt.set(cwd, Date.now());
    let cancelled = false;
    setFetching(true);
    void gitFetch(cwd)
      .then((res) => {
        if (cancelled) return;
        setFetching(false);
        if (res.ok) cbRef.current();
      })
      // try/finally semantics: even a rejected promise (network/IPC error) must
      // clear the in-flight flag instead of leaving the spinner pinned.
      .catch(() => {
        if (cancelled) return;
        setFetching(false);
      });
    // The cleanup runs on unmount, open/cwd change, and StrictMode remount; it
    // must reset fetching too, because the cancelled .then/.catch will no-op.
    return () => {
      cancelled = true;
      setFetching(false);
    };
  }, [open, cwd]);

  return fetching;
}
