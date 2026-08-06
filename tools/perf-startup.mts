/**
 * Startup/reload performance benchmark for the sidecar history layer.
 *
 * Measures the real cost of the paths that gate the sidebar and the active
 * chat on every app start / renderer reload, against the real on-disk
 * Factory session data (read-only):
 *
 *   1. loadHistoricalSessions  - the sessions.list backing scan (per call)
 *   2. loadMissionControlSessions - mission rows for the sidebar
 *   3. loadSessionTranscriptWindow - first history page of the newest session
 *
 * The session list is always served from a fresh scan of the session files,
 * so the first measurement below is the cost every sessions.list request
 * pays.
 *
 * Run from the repo root:
 *   node --import tsx tools/perf-startup.mts
 *
 * Keep this script honest: it must stay read-only and must exercise the same
 * production entry points the bridge uses, not private reimplementations.
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
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

console.log('— sessions.list fresh scan (the serving path on every request) —');
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

console.log(`\nsessions.list rows: ${rows2.length} (scan cost is independent of the filter)`);
