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

// Poll results are freshly deserialized every cycle; keep the previous object
// when the payload is unchanged so consumers' memo/effect deps stay stable and
// an idle repo doesn't cascade re-renders every 6 seconds.
function stable<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

export function useGitEnvironment(cwd: string, diffMode: DiffStatMode): GitEnvironmentState {
  const [env, setEnv] = useState<GitEnvironment | null>(null);
  const [branches, setBranches] = useState<GitBranchList | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [diffStat, setDiffStat] = useState<GitDiffStat | null>(null);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  // diffStat is written by both the full refresh and the mode-only effect;
  // a shared counter makes the most recently issued fetch the winner so a slow
  // full refresh cannot overwrite a newer mode change with the old mode's counts.
  const diffReqRef = useRef(0);
  const modeRef = useRef(diffMode);
  modeRef.current = diffMode;
  const loadedCwdRef = useRef('');

  const refresh = useCallback(() => {
    if (!cwd) {
      // Bump both counters so any in-flight load from the previous cwd can no
      // longer resolve and repopulate the panel with stale repo data.
      ++reqRef.current;
      ++diffReqRef.current;
      loadedCwdRef.current = '';
      setEnv(null);
      setBranches(null);
      setWorktrees([]);
      setDiffStat(null);
      // No fetch will run to clear this, and the 6s poll keeps hitting this
      // branch while cwd stays empty, so drop the flag here or it sticks true.
      setLoading(false);
      return;
    }
    if (loadedCwdRef.current !== cwd) {
      // cwd switched: drop the prior repo's data right away so stale env,
      // branches, worktrees, or diff counts are neither shown nor acted on
      // while the new environment loads. Polls (same cwd) skip this.
      loadedCwdRef.current = cwd;
      setEnv(null);
      setBranches(null);
      setWorktrees([]);
      setDiffStat(null);
    }
    const id = ++reqRef.current;
    const diffId = ++diffReqRef.current;
    setLoading(true);
    Promise.all([
      getGitEnvironment(cwd),
      getGitBranches(cwd),
      getGitWorktrees(cwd),
      getGitDiffStat(cwd, modeRef.current),
    ])
      .then(([nextEnv, nextBranches, nextWorktrees, nextDiff]) => {
        if (id !== reqRef.current) return;
        setEnv((prev) => stable(prev, nextEnv));
        setBranches((prev) => stable(prev, nextBranches));
        setWorktrees((prev) => stable(prev, nextWorktrees));
        if (diffId === diffReqRef.current) setDiffStat((prev) => stable(prev, nextDiff));
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
    const diffId = ++diffReqRef.current;
    void getGitDiffStat(cwd, diffMode).then((next) => {
      if (diffId === diffReqRef.current) setDiffStat((prev) => stable(prev, next));
    });
  }, [cwd, diffMode]);

  return { env, branches, worktrees, diffStat, loading, refresh };
}
