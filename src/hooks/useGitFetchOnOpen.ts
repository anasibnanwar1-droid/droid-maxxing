import { useEffect, useRef, useState } from 'react';
import { gitFetch } from '../lib/git';

// A fetch hits the network, so rapid open/close/reopen of a picker must not
// hammer the remote; one fetch per repo per interval is plenty for "branches
// pushed from elsewhere" freshness. Module-level so all pickers share it.
const MIN_FETCH_INTERVAL_MS = 30_000;
// Cap the throttle map so a long-lived renderer that visits many repos (or
// sub-directories) doesn't accumulate entries forever. Eviction is on-access:
// stale entries (older than the interval) are swept each time we read/write.
const MAX_THROTTLE_ENTRIES = 32;
const lastFetchAt = new Map<string, number>();
// One shared fetch per working directory: remounts (StrictMode) and throttle
// key changes (cwd -> repoRoot once the environment loads) subscribe to the
// running fetch instead of starting a second one or losing its result.
const inFlightByCwd = new Map<string, Promise<boolean>>();
// Throttle keys with a running fetch are exempt from eviction so the
// no-parallel-fetch guarantee survives visiting many repos in one interval.
const inFlightKeys = new Set<string>();

function pruneStaleFetchEntries() {
  if (lastFetchAt.size <= MAX_THROTTLE_ENTRIES) return;
  const cutoff = Date.now() - MIN_FETCH_INTERVAL_MS;
  for (const [key, ts] of lastFetchAt) {
    if (ts < cutoff && !inFlightKeys.has(key)) lastFetchAt.delete(key);
  }
  // If still over cap (many repos accessed within the interval), evict oldest.
  if (lastFetchAt.size > MAX_THROTTLE_ENTRIES) {
    const sorted = [...lastFetchAt.entries()]
      .filter(([key]) => !inFlightKeys.has(key))
      .sort((a, b) => a[1] - b[1]);
    const excess = lastFetchAt.size - MAX_THROTTLE_ENTRIES;
    for (let i = 0; i < excess && i < sorted.length; i++) lastFetchAt.delete(sorted[i][0]);
  }
}

// Best-effort `git fetch` when a branch picker opens so branches pushed from
// elsewhere appear without leaving the app. Fires once per open (not on every
// render or poll) and at most once per MIN_FETCH_INTERVAL_MS per repo, ignores
// offline/auth failures, and reports in-flight state so the caller can show a
// spinner. The callback is read through a ref so an unstable `onFetched`
// identity never re-triggers the fetch.
//
// `repoKey` optionally identifies the repository (e.g. repoRoot) for throttle
// purposes; when provided it is used instead of `cwd` so that viewing the same
// repo from different sub-directories or linked worktrees still shares the
// throttle window. Falls back to `cwd` when not available.
export function useGitFetchOnOpen(
  open: boolean,
  cwd: string,
  onFetched: () => void,
  repoKey?: string,
): boolean {
  const [fetching, setFetching] = useState(false);
  const cbRef = useRef(onFetched);
  cbRef.current = onFetched;
  // Throttle by repo identity when available so different sub-directory or
  // worktree paths into the same repo still share the fetch window.
  const throttleKey = repoKey ?? cwd;

  useEffect(() => {
    if (!open || !cwd) {
      // Closing (or losing the cwd) mid-fetch must clear the in-flight flag; the
      // prior run's cleanup cancels its .then, so nothing else will reset it.
      setFetching(false);
      return;
    }
    pruneStaleFetchEntries();
    let cancelled = false;
    const subscribe = (fetchDone: Promise<boolean>) => {
      setFetching(true);
      void fetchDone.then((ok) => {
        if (cancelled) return;
        setFetching(false);
        if (ok) cbRef.current();
      });
    };
    const running = inFlightByCwd.get(cwd);
    if (running) {
      // A StrictMode remount, or the throttle key changing from cwd to
      // repoRoot while the fetch is in flight, subscribes to the same fetch:
      // its result (and the spinner) is preserved without a second network
      // call, and the current key gets a throttle stamp for future opens.
      lastFetchAt.set(throttleKey, Date.now());
      subscribe(running);
      return () => {
        cancelled = true;
        setFetching(false);
      };
    }
    if (Date.now() - (lastFetchAt.get(throttleKey) ?? 0) < MIN_FETCH_INTERVAL_MS) {
      // Reset on every early-return path so the spinner can never get wedged
      // by a previous run's cancelled subscription.
      setFetching(false);
      return;
    }
    // Recorded at start (not completion) so a concurrent second picker, or a
    // failing remote, can't stack parallel fetches. try/finally semantics:
    // even a rejected promise (network/IPC error) resolves the shared promise
    // and clears the in-flight registries.
    lastFetchAt.set(throttleKey, Date.now());
    inFlightKeys.add(throttleKey);
    const fetchDone = gitFetch(cwd)
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        inFlightByCwd.delete(cwd);
        inFlightKeys.delete(throttleKey);
      });
    inFlightByCwd.set(cwd, fetchDone);
    subscribe(fetchDone);
    // The cleanup runs on unmount, open/cwd change, and StrictMode remount; it
    // must reset fetching too, because the cancelled subscription will no-op.
    return () => {
      cancelled = true;
      setFetching(false);
    };
  }, [open, cwd, throttleKey]);

  return fetching;
}
