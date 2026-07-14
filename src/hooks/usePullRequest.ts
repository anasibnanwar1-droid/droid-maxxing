import { useCallback, useEffect, useRef, useState } from 'react';
import { detectPullRequest, getPrChecks, getPrComments } from '../lib/github';
import type { PrCheck, PrComment, PullRequest } from '../types/vcs';

export interface PullRequestState {
  pr: PullRequest | null;
  checks: PrCheck[];
  comments: PrComment[];
  loadingDetail: boolean;
  refresh: () => void;
}

const DETECT_MS = 20000;
const DETAIL_MS = 12000;

// Detects the PR for the session's branch and, while the PR detail view is
// open, polls its checks and comments.
export function usePullRequest(
  cwd: string,
  branch: string | null,
  opts: { enabled: boolean; active: boolean },
): PullRequestState {
  const { enabled, active } = opts;
  const [pr, setPr] = useState<PullRequest | null>(null);
  const [checks, setChecks] = useState<PrCheck[]>([]);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const detectReq = useRef(0);
  const detailReq = useRef(0);

  const detect = useCallback(() => {
    // Bump first so any in-flight detection from a prior cwd/branch (or before
    // it was disabled) can no longer resolve and restore a stale PR.
    const id = ++detectReq.current;
    if (!enabled || !cwd) {
      setPr(null);
      return;
    }
    void detectPullRequest(cwd, branch ?? undefined).then((res) => {
      // A failed lookup (gh hiccup, network) keeps the last-known PR; only an
      // authoritative answer may replace or clear it. Keep the previous object
      // when the payload is unchanged so `pr`-dependent effects (the detail
      // poller) aren't torn down and restarted on every detection cycle.
      if (id === detectReq.current && res.ok) {
        setPr((prev) =>
          prev && res.pr && JSON.stringify(prev) === JSON.stringify(res.pr) ? prev : res.pr,
        );
      }
    });
  }, [enabled, cwd, branch]);

  // Drop the previous session's PR the moment cwd/branch changes so the panel
  // never shows or acts on a stale PR while the new detection is in flight. Bump
  // detailReq too, so an in-flight checks/comments fetch for the old PR can no
  // longer resolve and repopulate stale details under the newly detected PR.
  useEffect(() => {
    detailReq.current++;
    setPr(null);
    setChecks([]);
    setComments([]);
    setLoadingDetail(false);
  }, [cwd, branch]);

  // Each detection spawns a `gh` child process, so poll only while the window
  // is visible and re-detect immediately when it becomes visible again.
  useEffect(() => {
    detect();
    if (!enabled) return;
    const tick = () => {
      if (!document.hidden) detect();
    };
    const interval = window.setInterval(tick, DETECT_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [detect, enabled]);

  const refreshDetail = useCallback(() => {
    if (!cwd || !pr) return;
    const id = ++detailReq.current;
    setLoadingDetail(true);
    Promise.all([getPrChecks(cwd, pr.number), getPrComments(cwd, pr.number)])
      .then(([checkRes, commentRes]) => {
        if (id !== detailReq.current) return;
        setChecks(checkRes.checks);
        setComments(commentRes.comments);
        setLoadingDetail(false);
      })
      .catch(() => {
        if (id === detailReq.current) setLoadingDetail(false);
      });
  }, [cwd, pr]);

  useEffect(() => {
    if (!active || !pr) return;
    refreshDetail();
    const tick = () => {
      if (!document.hidden) refreshDetail();
    };
    const interval = window.setInterval(tick, DETAIL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [active, pr, refreshDetail]);

  const refresh = useCallback(() => {
    detect();
    refreshDetail();
  }, [detect, refreshDetail]);

  return { pr, checks, comments, loadingDetail, refresh };
}
