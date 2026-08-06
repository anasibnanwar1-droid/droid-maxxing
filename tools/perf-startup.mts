/**
 * Startup/reload performance benchmark for the sidecar history layer.
 *
 * Measures the real cost of the paths that gate the sidebar and the active
 * chat on every app start / renderer reload, against the real on-disk
 * Factory session data (read-only):
 *
 *   1. loadHistoricalSessions  - the old sessions.list backing scan (per call)
 *   2. HistoryIndex.reconcileSessionFiles - one-time cache populate / refresh
 *   3. HistoryIndex.listHistoricalSessions - the cached sessions.list path
 *   4. loadMissionControlSessions - mission rows for the sidebar
 *   5. loadSessionTranscriptWindow - first history page of the newest session
 *
 * Live external changes go through HistoryIndex.reconcileSessionFilePaths,
 * which stats (and at most re-parses) exactly the files the watcher reported,
 * so the steady-state cost per external edit is microseconds, not a tree walk.
 *
 * The HistoryIndex measurements run in a scratch HOME whose sessions dir is a
 * symlink to the real one, so the sqlite cache writes land in the scratch dir
 * and the real ~/.factory data is never modified.
 *
 * Run from the repo root:
 *   node --import tsx tools/perf-startup.mts
 *
 * Keep this script honest: it must stay read-only and must exercise the same
 * production entry points the bridge uses, not private reimplementations.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  HistoryIndex,
  loadHistoricalSessions,
  loadMissionControlSessions,
  loadSessionTranscriptWindow,
  resolveSessionChain,
} from '../sidecar/src/history.js';

function time<T>(label: string, fn: () => T): { ms: number; result: T } {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  console.log(`${label.padEnd(52)} ${ms.toFixed(1).padStart(9)} ms`);
  return { ms, result };
}

function newestProviderSessionId(): string | null {
  const root = join(homedir(), '.factory', 'sessions');
  let newest: { id: string; mtime: number } | null = null;
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path, depth + 1);
      } else if (name.endsWith('.jsonl')) {
        if (!newest || stat.mtimeMs > newest.mtime) {
          newest = { id: name.slice(0, -'.jsonl'.length), mtime: stat.mtimeMs };
        }
      }
    }
  };
  walk(root, 0);
  return newest?.id ?? null;
}

console.log('DROIDEX startup perf benchmark (real ~/.factory data, read-only)\n');

// The renderer calls sessions.list with its workspace cwds; the expensive part
// (index rebuild + per-file head reads) runs for every file regardless of the
// filter, so plain-chat mode measures the same scan cost.
const listOptions = { includePlainChats: true };

console.log('— uncached path (pre-cache behavior, still the empty-cache fallback) —');
time('loadHistoricalSessions (sessions.list) call #1', () =>
  loadHistoricalSessions(listOptions),
);
const { result: rows2 } = time('loadHistoricalSessions (sessions.list) call #2', () =>
  loadHistoricalSessions(listOptions),
);
time('loadMissionControlSessions call #1', () => loadMissionControlSessions(listOptions));
time('loadMissionControlSessions call #2', () => loadMissionControlSessions(listOptions));

const newest = newestProviderSessionId();
if (newest) {
  const { result: chain } = time(`resolveSessionChain (${newest.slice(0, 8)}…)`, () =>
    resolveSessionChain(newest, newest),
  );
  time(`loadSessionTranscriptWindow first page (${chain.length} segment(s))`, () =>
    loadSessionTranscriptWindow(newest, chain),
  );
  time('loadSessionTranscriptWindow first page repeat', () =>
    loadSessionTranscriptWindow(newest, chain),
  );
} else {
  console.log('no session files found; skipping transcript benchmark');
}

// Cached path: scratch HOME with a symlinked sessions dir keeps the benchmark
// read-only against the real data while scanning the real files.
const scratchHome = mkdtempSync(join(tmpdir(), 'droidex-perf-home-'));
const previousHome = process.env.HOME;
try {
  mkdirSync(join(scratchHome, '.factory', 'droidex'), { recursive: true });
  symlinkSync(
    join(homedir(), '.factory', 'sessions'),
    join(scratchHome, '.factory', 'sessions'),
    'dir',
  );
  // Copy the summary overlay so the cached list applies the same patches as
  // the uncached one and the row counts are comparable.
  for (const suffix of ['', '-wal', '-shm']) {
    const name = `session-index.sqlite${suffix}`;
    const source = join(homedir(), '.factory', 'droidex', name);
    if (existsSync(source)) copyFileSync(source, join(scratchHome, '.factory', 'droidex', name));
  }
  process.env.HOME = scratchHome;

  console.log('\n— cached path (scratch HOME, real session files via symlink) —');
  const index = new HistoryIndex();
  try {
    time('reconcileSessionFiles (empty cache: first-run populate)', () =>
      index.reconcileSessionFiles(),
    );
    const { result: cachedRows } = time('cached listHistoricalSessions call #1', () =>
      index.listHistoricalSessions(listOptions),
    );
    time('cached listHistoricalSessions call #2', () => index.listHistoricalSessions(listOptions));
    time('reconcileSessionFiles (warm cache: steady-state boot diff)', () =>
      index.reconcileSessionFiles(),
    );
    console.log(
      `\nsessions.list rows: uncached ${rows2.length}, cached ${cachedRows.length} (scan cost is independent of the filter)`,
    );
  } finally {
    index.close();
  }
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(scratchHome, { recursive: true, force: true });
}
