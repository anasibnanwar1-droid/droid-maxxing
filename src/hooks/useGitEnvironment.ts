import { useCallback, useEffect, useReducer } from 'react';
import { getGitBranches, getGitDiffStat, getGitEnvironment, getGitWorktrees } from '../lib/git';
import { stable } from '../lib/stable';
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

// How long a poller with no subscribers survives before teardown. Covers a
// single subscriber remounting (panel switch, StrictMode double-invoke), which
// would otherwise destroy and recreate the poller, losing the cached snapshot
// and flashing a loading state.
const TEARDOWN_GRACE_MS = 1000;

// Every poll tick spawns a dozen git subprocesses, so hook instances watching
// the same repo (e.g. the Context panel and the Review pane) must share one
// polling loop instead of stacking independent ones. Entries are keyed by cwd
// and refcounted: the first subscriber starts the poller, the last one tears
// it down. Diff stats are cached per mode because subscribers can watch the
// same repo through different diff scopes.
interface StoreEntry {
  cwd: string;
  env: GitEnvironment | null;
  branches: GitBranchList | null;
  worktrees: GitWorktree[];
  diffStats: Partial<Record<DiffStatMode, GitDiffStat | null>>;
  loading: boolean;
  // True until the FIRST refresh for this entry resolves (success or failure);
  // background poll ticks must not toggle `loading`, only the initial load does,
  // so subscribers don't flash a spinner on every POLL_MS cycle.
  hasLoaded: boolean;
  // In-flight guard: when a refresh is pending, skip subsequent interval ticks
  // so a slow tick (slower than POLL_MS) can't stack parallel git subprocesses.
  refreshing: boolean;
  // The req id of the currently in-flight refresh. When it no longer matches
  // entry.req the in-flight results will be dropped, so a re-acquire during
  // the initial load can tell "valid load pending" from "load invalidated".
  inFlightReq: number;
  // Set when a refresh is requested while one is in flight (an explicit
  // refresh after commit/PR/checkout, or a remount that invalidated the
  // initial load). The in-flight request may resolve with a pre-action
  // snapshot, so a queued refresh re-runs as soon as it settles instead of
  // waiting for the next poll tick.
  refreshQueued: boolean;
  listeners: Set<() => void>;
  modeCounts: Map<DiffStatMode, number>;
  // Monotonic fetch id: bumped on every refresh (and on teardown) so a slow
  // in-flight load can never overwrite the results of a newer one. Also bumped
  // when a mode is released, so an in-flight diff-stat fetch for a just-removed
  // mode can't resolve and overwrite data after the mode is re-acquired.
  req: number;
  interval: number;
  onVisible: () => void;
  teardownTimer: number | null;
}

const store = new Map<string, StoreEntry>();

function notify(entry: StoreEntry) {
  entry.listeners.forEach((listener) => listener());
}

function refreshEntry(entry: StoreEntry) {
  // In-flight guard: a tick that fires while the previous refresh is still
  // pending would spawn another batch of git subprocesses whose results are
  // dropped anyway (req mismatch). Skip instead of stacking work.
  if (entry.refreshing) return;
  entry.refreshing = true;
  const id = ++entry.req;
  entry.inFlightReq = id;
  const modes = [...entry.modeCounts.keys()];
  const isFirstLoad = !entry.hasLoaded;
  // Only the initial load toggles `loading`; background refreshes update the
  // snapshot silently so subscribers don't re-render into a loading state every
  // poll tick (which caused flicker on every POLL_MS cycle).
  if (isFirstLoad) {
    entry.loading = true;
    notify(entry);
  }
  Promise.all([
    getGitEnvironment(entry.cwd),
    getGitBranches(entry.cwd),
    getGitWorktrees(entry.cwd),
    Promise.all(modes.map((mode) => getGitDiffStat(entry.cwd, mode))),
  ])
    .then(([env, branches, worktrees, stats]) => {
      // We're the single in-flight refresh (refreshEntry is single-flight via
      // the guard above), so always release the lock — even if req was bumped
      // out from under us by release()/teardown, no other refreshEntry could
      // have started while we held it, so clearing is always safe.
      entry.refreshing = false;
      if (id !== entry.req) return;
      // Track whether any reference actually changed so a silent background
      // refresh only notifies subscribers when there's new data to render.
      const prevEnv = entry.env;
      const prevBranches = entry.branches;
      const prevWorktrees = entry.worktrees;
      const prevStats = modes.map((mode) => entry.diffStats[mode] ?? null);
      entry.env = stable(prevEnv, env);
      entry.branches = stable(prevBranches, branches);
      entry.worktrees = stable(prevWorktrees, worktrees);
      let changed =
        entry.env !== prevEnv ||
        entry.branches !== prevBranches ||
        entry.worktrees !== prevWorktrees;
      modes.forEach((mode, i) => {
        const next = stable(prevStats[i], stats[i]);
        entry.diffStats[mode] = next;
        if (next !== prevStats[i]) changed = true;
      });
      entry.hasLoaded = true;
      // First load always notifies (to clear the loading spinner); background
      // refreshes only notify when something actually changed.
      if (isFirstLoad || changed) {
        if (isFirstLoad) entry.loading = false;
        notify(entry);
      }
    })
    .catch(() => {
      entry.refreshing = false;
      if (id !== entry.req) return;
      entry.hasLoaded = true;
      if (isFirstLoad) {
        entry.loading = false;
        notify(entry);
      }
    })
    // Runs after the result handlers above, so a queued refresh (requested
    // while this one was in flight) starts against the fully applied snapshot.
    .finally(() => {
      if (entry.refreshQueued && store.get(entry.cwd) === entry) {
        entry.refreshQueued = false;
        refreshEntry(entry);
      }
    });
}

// Run a refresh now, or queue one to run when the in-flight refresh settles.
// The in-flight request may have started before the caller's action (commit,
// PR, checkout, worktree change), so skipping would leave the snapshot stale
// until the next poll tick.
function requestRefresh(entry: StoreEntry) {
  if (entry.refreshing) entry.refreshQueued = true;
  else refreshEntry(entry);
}

function refreshDiffStat(entry: StoreEntry, mode: DiffStatMode) {
  const id = entry.req;
  void getGitDiffStat(entry.cwd, mode).then((next) => {
    if (id !== entry.req || !entry.modeCounts.has(mode)) return;
    const prev = entry.diffStats[mode] ?? null;
    entry.diffStats[mode] = stable(prev, next);
    if (entry.diffStats[mode] !== prev) notify(entry);
  });
}

function acquire(cwd: string, mode: DiffStatMode, listener: () => void): StoreEntry {
  let entry = store.get(cwd);
  const isNew = !entry;
  if (!entry) {
    const created: StoreEntry = {
      cwd,
      env: null,
      branches: null,
      worktrees: [],
      diffStats: {},
      loading: true,
      hasLoaded: false,
      refreshing: false,
      inFlightReq: 0,
      refreshQueued: false,
      listeners: new Set(),
      modeCounts: new Map(),
      req: 0,
      interval: 0,
      onVisible: () => {},
      teardownTimer: null,
    };
    created.onVisible = () => {
      // Skip ticks while a refresh is already pending so slow ticks can't
      // stack parallel git subprocesses.
      if (!document.hidden && !created.refreshing) refreshEntry(created);
    };
    created.interval = window.setInterval(created.onVisible, POLL_MS);
    document.addEventListener('visibilitychange', created.onVisible);
    store.set(cwd, created);
    entry = created;
  }
  if (entry.teardownTimer !== null) {
    window.clearTimeout(entry.teardownTimer);
    entry.teardownTimer = null;
  }
  entry.listeners.add(listener);
  const hadMode = entry.modeCounts.has(mode);
  entry.modeCounts.set(mode, (entry.modeCounts.get(mode) ?? 0) + 1);
  if (isNew) refreshEntry(entry);
  else if (!entry.hasLoaded && (!entry.refreshing || entry.req !== entry.inFlightReq)) {
    // Re-acquire before the initial load landed (StrictMode remount, rapid
    // panel reopen): release() bumped req, so the in-flight load's results
    // will be dropped and nothing else would populate the snapshot until the
    // next poll tick. Re-run (or queue) the full refresh. When the in-flight
    // load is still valid (req matches), it will populate the entry itself.
    requestRefresh(entry);
  }
  // A newly watched mode on an existing entry only needs its diff stat; the
  // rest of the snapshot is mode-independent and already polling.
  else if (!hadMode) refreshDiffStat(entry, mode);
  return entry;
}

function release(cwd: string, mode: DiffStatMode, listener: () => void) {
  const entry = store.get(cwd);
  if (!entry) return;
  entry.listeners.delete(listener);
  const count = entry.modeCounts.get(mode) ?? 0;
  if (count <= 1) {
    entry.modeCounts.delete(mode);
    delete entry.diffStats[mode];
    // Invalidate any in-flight diff-stat fetch for this mode: without a bump,
    // a slow in-flight request could resolve AFTER the mode is re-acquired
    // (while another subscriber keeps the entry alive) and overwrite the
    // fresher data the re-acquire's fetch will have written. Bumping req makes
    // the stale in-flight's id check fail so it's dropped.
    entry.req++;
  } else {
    entry.modeCounts.set(mode, count - 1);
  }
  if (entry.listeners.size === 0 && entry.teardownTimer === null) {
    entry.teardownTimer = window.setTimeout(() => {
      entry.teardownTimer = null;
      if (entry.listeners.size > 0) return;
      entry.req++;
      window.clearInterval(entry.interval);
      document.removeEventListener('visibilitychange', entry.onVisible);
      store.delete(cwd);
    }, TEARDOWN_GRACE_MS);
  }
}

const EMPTY_WORKTREES: GitWorktree[] = [];

export function useGitEnvironment(cwd: string, diffMode: DiffStatMode): GitEnvironmentState {
  const [, bump] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!cwd) return;
    const listener = () => bump();
    acquire(cwd, diffMode, listener);
    bump();
    return () => release(cwd, diffMode, listener);
  }, [cwd, diffMode]);

  const refresh = useCallback(() => {
    const entry = store.get(cwd);
    if (entry) requestRefresh(entry);
  }, [cwd]);

  const entry = cwd ? store.get(cwd) : undefined;
  return {
    env: entry?.env ?? null,
    branches: entry?.branches ?? null,
    worktrees: entry?.worktrees ?? EMPTY_WORKTREES,
    diffStat: entry?.diffStats[diffMode] ?? null,
    loading: entry?.loading ?? false,
    refresh,
  };
}
