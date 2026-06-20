import { useCallback, useEffect, useRef, useState } from 'react';
import { getGitBranches, getGitDiffStat, getGitEnvironment, getGitWorktrees } from '../lib/git';
import type {
  DiffStatMode,
  GitBranchList,
  GitDiffStat,
  GitEnvironment,
  GitWorktree,
} from '../types/vcs';

export interface GitEnvironmentState {
  env: GitEnvironment | null;
  branches: GitBranchList | null;
  worktrees: GitWorktree[];
  diffStat: GitDiffStat | null;
  loading: boolean;
  refresh: () => void;
}

const POLL_MS = 6000;

export function useGitEnvironment(cwd: string, diffMode: DiffStatMode): GitEnvironmentState {
  const [env, setEnv] = useState<GitEnvironment | null>(null);
  const [branches, setBranches] = useState<GitBranchList | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [diffStat, setDiffStat] = useState<GitDiffStat | null>(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  const modeRef = useRef(diffMode);
  modeRef.current = diffMode;

  const refresh = useCallback(() => {
    if (!cwd) {
      setEnv(null);
      setBranches(null);
      setWorktrees([]);
      setDiffStat(null);
      return;
    }
    const id = ++reqRef.current;
    setLoading(true);
    Promise.all([
      getGitEnvironment(cwd),
      getGitBranches(cwd),
      getGitWorktrees(cwd),
      getGitDiffStat(cwd, modeRef.current),
    ])
      .then(([nextEnv, nextBranches, nextWorktrees, nextDiff]) => {
        if (id !== reqRef.current) return;
        setEnv(nextEnv);
        setBranches(nextBranches);
        setWorktrees(nextWorktrees);
        setDiffStat(nextDiff);
        setLoading(false);
      })
      .catch(() => {
        if (id === reqRef.current) setLoading(false);
      });
  }, [cwd]);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  // Refetch only the diff stat when the selected mode changes.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    void getGitDiffStat(cwd, diffMode).then((next) => {
      if (!cancelled) setDiffStat(next);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, diffMode]);

  return { env, branches, worktrees, diffStat, loading, refresh };
}
