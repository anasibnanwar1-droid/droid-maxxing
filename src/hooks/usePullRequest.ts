import { useCallback, useEffect, useRef, useState } from 'react';
import { detectPullRequest, getPrChecks, getPrComments } from '../lib/github';
import { stable } from '../lib/stable';
import type { PrCheck, PrComment, PullRequest } from '../types/vcs';

export interface PullRequestState {
  pr: PullRequest | null;
  checks: PrCheck[];
  comments: PrComment[];
  loadingDetail: boolean;
  // False until the first checks/comments fetch for this cwd/branch resolves,
  // so empty arrays can be rendered as "loading" instead of "none exist".
  // Also settles to true on a FAILED initial load so the panel doesn't spin
  // forever when gh/IPC is unavailable.
  detailLoaded: boolean;
  // Set when the most recent detail fetch failed outright (gh hiccup, not
  // desktop, etc.) so the panel can show an error line instead of the
  // misleading "No checks reported"/"No comments yet" empty states that are
  // indistinguishable from a genuinely empty PR.
  detailError: string | null;
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
  const [detailLoaded, setDetailLoaded] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Mirrors detailLoaded so refreshDetail can read it without taking it as a
  // dependency (which would restart the polling interval on the first load).
  const detailLoadedRef = useRef(false);
  const detectReq = useRef(0);
  const detailReq = useRef(0);
  // Which cwd the current `pr` was detected for. On a cwd switch the clear
  // effect only lands next render, so the detail poller can otherwise fire once
  // with the previous repo's PR number against the new cwd.
  const prCwd = useRef<string | null>(null);
  // Tracks the PR number the current detail state belongs to. When detection
  // finds a different PR on the same branch (old PR closed, new one opened),
  // the old checks/comments must be cleared and reloaded.
  const prNumberRef = useRef<number | null>(null);

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
        prCwd.current = cwd;
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
    prNumberRef.current = null;
    setPr(null);
    setChecks([]);
    setComments([]);
    setLoadingDetail(false);
    setDetailLoaded(false);
    setDetailError(null);
    detailLoadedRef.current = false;
  }, [cwd, branch]);

  // When the detected PR number changes on the SAME branch (e.g. old PR closed,
  // new one opened), stale checks/comments from the previous PR must be cleared
  // and the detail loading state reset so the panel shows a reload indicator
  // instead of the old PR's data.
  useEffect(() => {
    const num = pr?.number ?? null;
    if (prNumberRef.current !== null && prNumberRef.current !== num) {
      detailReq.current++;
      setChecks([]);
      setComments([]);
      setLoadingDetail(false);
      setDetailLoaded(false);
      setDetailError(null);
      detailLoadedRef.current = false;
    }
    prNumberRef.current = num;
  }, [pr?.number]);

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

  const refreshDetail = useCallback(
    (userInitiated = false) => {
      if (!cwd || !pr || prCwd.current !== cwd) return;
      const id = ++detailReq.current;
      const isFirstLoad = !detailLoadedRef.current;
      // Background poll ticks refresh silently; the spinner only shows for the
      // initial load and explicit user refreshes, so the panel doesn't flash
      // its loading state every poll interval.
      if (userInitiated || isFirstLoad) setLoadingDetail(true);
      Promise.all([getPrChecks(cwd, pr.number), getPrComments(cwd, pr.number)])
        .then(([checkRes, commentRes]) => {
          if (id !== detailReq.current) return;
          const bothOk = checkRes.ok && commentRes.ok;
          // The fetchers resolve ok:false with empty arrays on gh/IPC hiccups;
          // keep the last-known data instead of blanking rows until the next
          // successful poll.
          if (checkRes.ok) setChecks((prev) => stable(prev, checkRes.checks));
          if (commentRes.ok) setComments((prev) => stable(prev, commentRes.comments));
          setLoadingDetail(false);
          if (bothOk) {
            setDetailError(null);
          } else if (isFirstLoad || userInitiated) {
            // Only surface an error when there's no prior data to fall back on
            // (initial load) or the user explicitly asked for a refresh; a
            // transient background-poll hiccup keeps showing the last-known
            // rows without flickering an error banner.
            setDetailError(checkRes.message || commentRes.message || 'Could not load PR details');
          }
          // Settle the initial-load flag on BOTH success and failure: without
          // this, a failed first fetch leaves detailLoaded=false forever, so the
          // panel's loading fallback (loadingDetail || !detailLoaded) spins
          // indefinitely even though no request is pending.
          if (isFirstLoad) {
            setDetailLoaded(true);
            detailLoadedRef.current = true;
          }
        })
        .catch(() => {
          if (id !== detailReq.current) return;
          setLoadingDetail(false);
          if (isFirstLoad) {
            setDetailLoaded(true);
            detailLoadedRef.current = true;
            setDetailError('Could not load PR details');
          }
        });
    },
    [cwd, pr],
  );

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
    refreshDetail(true);
  }, [detect, refreshDetail]);

  return { pr, checks, comments, loadingDetail, detailLoaded, detailError, refresh };
}
