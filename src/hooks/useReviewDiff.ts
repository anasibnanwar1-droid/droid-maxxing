import { useCallback, useEffect, useRef, useState } from 'react';
import { getGitDiffFiles, getGitFileDiff } from '../lib/git';
import type { DiffFile, DiffScope, FileDiffResult } from '../types/vcs';

const POLL_MS = 8000;

export interface ReviewDiffState {
  files: DiffFile[];
  base: string | null;
  loadingList: boolean;
  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
  fileDiff: FileDiffResult | null;
  loadingDiff: boolean;
  refresh: () => void;
}

// Drives the Review tab: keeps the scoped file list fresh (light polling so the
// view tracks the agent's edits) and lazily loads the selected file's diff.
export function useReviewDiff(
  cwd: string,
  scope: DiffScope,
  enabled: boolean,
  ignoreWhitespace = false,
): ReviewDiffState {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [base, setBase] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiffResult | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [version, setVersion] = useState(0);
  const listReq = useRef(0);
  const diffReq = useRef(0);
  const diffKey = useRef('');

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
        setVersion((v) => v + 1);
        setSelectedPath((cur) =>
          cur && res.files.some((f) => f.path === cur) ? cur : (res.files[0]?.path ?? null),
        );
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

  useEffect(() => {
    if (!cwd || !enabled || !selectedPath) {
      setFileDiff(null);
      return;
    }
    // Drop the prior scope/file's diff so a stale one is never shown while the
    // newly scoped diff loads (the same path can exist in multiple scopes, and
    // toggling whitespace refetches the same path). Skip this on poll refreshes
    // (version bumps) to avoid flicker.
    const key = `${cwd}\u0000${scope}\u0000${selectedPath}\u0000${ignoreWhitespace}`;
    if (diffKey.current !== key) {
      diffKey.current = key;
      setFileDiff(null);
    }
    const id = ++diffReq.current;
    setLoadingDiff(true);
    getGitFileDiff(cwd, scope, selectedPath, ignoreWhitespace)
      .then((res) => {
        if (id !== diffReq.current) return;
        setFileDiff(res);
        setLoadingDiff(false);
      })
      .catch(() => {
        if (id === diffReq.current) setLoadingDiff(false);
      });
  }, [cwd, scope, selectedPath, enabled, version, ignoreWhitespace]);

  return {
    files,
    base,
    loadingList,
    selectedPath,
    setSelectedPath,
    fileDiff,
    loadingDiff,
    refresh: loadList,
  };
}
