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

  const loadList = useCallback(() => {
    if (!cwd || !enabled) {
      // Bump the request id so an in-flight load from the previous cwd can't
      // resolve and repopulate the list with stale files, and clear the loading
      // flag since no fetch will complete to do it.
      ++listReq.current;
      setFiles([]);
      setBase(null);
      setLoadingList(false);
      return;
    }
    const id = ++listReq.current;
    setLoadingList(true);
    getGitDiffFiles(cwd, scope, sessionId)
      .then((res) => {
        if (id !== listReq.current) return;
        // Poll results are freshly deserialized; keep the previous array when
        // nothing changed so downstream memos and effects keyed on `files`
        // stay stable across idle polls.
        setFiles((prev) => (JSON.stringify(prev) === JSON.stringify(res.files) ? prev : res.files));
        setBase(res.base);
        setLoadingList(false);
      })
      .catch(() => {
        if (id === listReq.current) setLoadingList(false);
      });
  }, [cwd, scope, enabled, sessionId]);

  // Poll only while the window is visible (no git subprocess churn when the
  // app is in the background); refresh immediately on becoming visible again.
  useEffect(() => {
    loadList();
    if (!enabled) return;
    const tick = () => {
      if (!document.hidden) loadList();
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
