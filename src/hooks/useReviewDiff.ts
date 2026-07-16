import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getGitDiffFiles } from '../lib/git';
import type { DiffFile, DiffScope } from '../types/vcs';

const POLL_MS = 8000;

export interface ReviewDiffState {
  files: DiffFile[];
  base: string | null;
  loadingList: boolean;
  signature: string;
  refresh: () => void;
}

// Drives the Review tab's file list, kept fresh with light polling so the view
// tracks the agent's edits. Per-file diffs are loaded lazily by
// useReviewFileDiffs when a section is expanded, so this hook only owns the
// list and a content signature consumers use to invalidate cached diffs.
export function useReviewDiff(
  cwd: string,
  scope: DiffScope,
  enabled: boolean,
  sessionId?: string,
): ReviewDiffState {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [base, setBase] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const listReq = useRef(0);
  // In-flight flag: poll ticks consult this so a tick that fires while the
  // previous load is still pending is skipped (no stacked git subprocesses).
  // Direct calls (initial load, dep-change reload, user refresh) bypass the
  // guard via the effect, so a cwd/scope switch always starts a fresh load
  // instead of being blocked by a lingering request for the old scope.
  const inFlight = useRef(false);
  // Tracks the (cwd, scope, sessionId) tuple that loadingList was last shown
  // for. Background poll ticks must NOT toggle loadingList — only the first
  // load for a given scope/cwd shows the spinner, so the list doesn't flash
  // every POLL_MS cycle.
  const loadedKey = useRef<string | null>(null);

  const loadList = useCallback(() => {
    if (!cwd || !enabled) {
      // Bump the request id so an in-flight load from the previous cwd can't
      // resolve and repopulate the list with stale files, and clear the loading
      // flag since no fetch will complete to do it.
      ++listReq.current;
      inFlight.current = false;
      loadedKey.current = null;
      setFiles([]);
      setBase(null);
      setLoadingList(false);
      return;
    }
    const key = `${cwd}|${scope}|${sessionId ?? ''}`;
    const isFirstLoad = loadedKey.current !== key;
    const id = ++listReq.current;
    inFlight.current = true;
    if (isFirstLoad) setLoadingList(true);
    getGitDiffFiles(cwd, scope, sessionId)
      .then((res) => {
        if (id !== listReq.current) return;
        // Poll results are freshly deserialized; keep the previous array when
        // nothing changed so downstream memos and effects keyed on `files`
        // stay stable across idle polls.
        setFiles((prev) => (JSON.stringify(prev) === JSON.stringify(res.files) ? prev : res.files));
        setBase(res.base);
        loadedKey.current = key;
        inFlight.current = false;
        if (isFirstLoad) setLoadingList(false);
      })
      .catch(() => {
        if (id === listReq.current) {
          inFlight.current = false;
          if (isFirstLoad) setLoadingList(false);
        }
      });
  }, [cwd, scope, enabled, sessionId]);

  // Poll only while the window is visible (no git subprocess churn when the
  // app is in the background); refresh immediately on becoming visible again.
  useEffect(() => {
    loadList();
    if (!enabled) return;
    const tick = () => {
      // Skip ticks while a load is pending so a slow tick can't stack a second
      // git subprocess whose results would be dropped anyway.
      if (!document.hidden && !inFlight.current) loadList();
    };
    const interval = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [loadList, enabled]);

  // Changes only when a file's identity or line counts change, so an idle poll
  // that returns the same list never invalidates the open sections' diffs.
  const signature = useMemo(
    () => files.map((f) => `${f.path}:${f.status}:${f.additions}:${f.deletions}`).join('\n'),
    [files],
  );

  return { files, base, loadingList, signature, refresh: loadList };
}
