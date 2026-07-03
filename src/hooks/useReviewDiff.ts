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
export function useReviewDiff(cwd: string, scope: DiffScope, enabled: boolean): ReviewDiffState {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [base, setBase] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const listReq = useRef(0);

  const loadList = useCallback(() => {
    if (!cwd || !enabled) {
      setFiles([]);
      setBase(null);
      return;
    }
    const id = ++listReq.current;
    setLoadingList(true);
    getGitDiffFiles(cwd, scope)
      .then((res) => {
        if (id !== listReq.current) return;
        setFiles(res.files);
        setBase(res.base);
        setLoadingList(false);
      })
      .catch(() => {
        if (id === listReq.current) setLoadingList(false);
      });
  }, [cwd, scope, enabled]);

  useEffect(() => {
    loadList();
    if (!enabled) return;
    const interval = window.setInterval(loadList, POLL_MS);
    return () => window.clearInterval(interval);
  }, [loadList, enabled]);

  // Changes only when a file's identity or line counts change, so an idle poll
  // that returns the same list never invalidates the open sections' diffs.
  const signature = useMemo(
    () => files.map((f) => `${f.path}:${f.status}:${f.additions}:${f.deletions}`).join('\n'),
    [files],
  );

  return { files, base, loadingList, signature, refresh: loadList };
}
