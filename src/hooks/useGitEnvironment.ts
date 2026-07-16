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
  listeners: Set<() => void>;
  modeCounts: Map<DiffStatMode, number>;
  // Monotonic fetch id: bumped on every refresh (and on teardown) so a slow
  // in-flight load can never overwrite the results of a newer one.
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
  const id = ++entry.req;
  const modes = [...entry.modeCounts.keys()];
  entry.loading = true;
  notify(entry);
  Promise.all([
    getGitEnvironment(entry.cwd),
    getGitBranches(entry.cwd),
    getGitWorktrees(entry.cwd),
    Promise.all(modes.map((mode) => getGitDiffStat(entry.cwd, mode))),
  ])
    .then(([env, branches, worktrees, stats]) => {
      if (id !== entry.req) return;
      entry.env = stable(entry.env, env);
      entry.branches = stable(entry.branches, branches);
      entry.worktrees = stable(entry.worktrees, worktrees);
      modes.forEach((mode, i) => {
        entry.diffStats[mode] = stable(entry.diffStats[mode] ?? null, stats[i]);
      });
      entry.loading = false;
      notify(entry);
    })
    .catch(() => {
      if (id !== entry.req) return;
      entry.loading = false;
      notify(entry);
    });
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
      listeners: new Set(),
      modeCounts: new Map(),
      req: 0,
      interval: 0,
      onVisible: () => {},
      teardownTimer: null,
    };
    created.onVisible = () => {
      if (!document.hidden) refreshEntry(created);
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
    if (entry) refreshEntry(entry);
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
