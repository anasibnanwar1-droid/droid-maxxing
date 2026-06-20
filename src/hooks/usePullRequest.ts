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
    if (!enabled || !cwd) {
      setPr(null);
      return;
    }
    const id = ++detectReq.current;
    void detectPullRequest(cwd, branch ?? undefined).then((next) => {
      if (id === detectReq.current) setPr(next);
    });
  }, [enabled, cwd, branch]);

  useEffect(() => {
    detect();
    if (!enabled) return;
    const interval = window.setInterval(detect, DETECT_MS);
    return () => window.clearInterval(interval);
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
    const interval = window.setInterval(refreshDetail, DETAIL_MS);
    return () => window.clearInterval(interval);
  }, [active, pr, refreshDetail]);

  const refresh = useCallback(() => {
    detect();
    refreshDetail();
  }, [detect, refreshDetail]);

  return { pr, checks, comments, loadingDetail, refresh };
}
