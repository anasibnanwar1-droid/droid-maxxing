import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MissionSummary } from './protocol.js';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-history-home-'));
process.env.HOME = home;

const { HistoryIndex, loadHistoricalSessions } = await import('./history.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function writeSession(id: string, cwd: string, extra: Record<string, unknown> = {}): void {
  const dir = join(home, '.factory', 'sessions', '2026', '06');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({
      type: 'session_start',
      cwd,
      sessionTitle: 'Plain chat',
      settings: { interactionMode: 'auto' },
      ...extra,
    })}\n`,
  );
}

function summary(id: string, cwd: string): MissionSummary {
  const now = Date.now();
  return {
    id,
    sessionId: id,
    kind: 'chat',
    role: 'orchestrator',
    title: 'Plain chat',
    goal: 'Plain chat',
    cwd,
    workspaceKind: cwd ? 'folder' : 'none',
    autonomy: 'low',
    phase: 'paused',
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}

test('loadHistoricalSessions applies app summaries before plain chat filtering', () => {
  writeSession('plain-runtime-home', home);
  const index = new HistoryIndex();
  index.syncSummaries([summary('plain-runtime-home', '')]);
  index.close();

  const rows = loadHistoricalSessions({ includePlainChats: true, limitPerWorkspace: 5 });

  assert.deepEqual(
    rows.map((row) => row.summary.id),
    ['plain-runtime-home'],
  );
  assert.equal(rows[0].summary.cwd, '');
  assert.equal(rows[0].summary.workspaceKind, 'none');
});

test('loadHistoricalSessions hides a Task-spawned subagent that has a persisted worker link', () => {
  const cwd = join(home, 'workspace-subagent');
  writeSession('real-session', cwd);
  writeSession('subagent-session', cwd, {
    callingSessionId: 'real-session',
    callingToolUseId: 'tool-1',
  });
  // A persisted link lets the parent chat open it as a worker, so it must not
  // also surface as a standalone session.
  const index = new HistoryIndex();
  index.recordSubagentLink('real-session', 'tool-1', 'subagent-session');
  index.close();

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  assert.deepEqual(
    rows.map((row) => row.summary.id),
    ['real-session'],
  );
});

test('loadHistoricalSessions keeps a marker-only Task subagent visible when it has no persisted link', () => {
  const cwd = join(home, 'workspace-orphan');
  writeSession('orphan-parent', cwd);
  // Recorded before links were persisted: spawn markers but no subagent_links
  // row. Hiding it would orphan it (the parent has no link to open it), so it
  // must remain a standalone, openable session.
  writeSession('orphan-subagent', cwd, {
    callingSessionId: 'orphan-parent',
    callingToolUseId: 'tool-7',
  });

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  assert.deepEqual(rows.map((row) => row.summary.id).sort(), ['orphan-parent', 'orphan-subagent']);
});

test('loadHistoricalSessions keeps a rekeyed worker hidden under its superseded id', () => {
  const cwd = join(home, 'workspace-rekey');
  writeSession('rekey-parent', cwd);
  writeSession('worker-old', cwd, { callingSessionId: 'rekey-parent', callingToolUseId: 'tool-r' });
  writeSession('worker-new', cwd, { callingSessionId: 'rekey-parent', callingToolUseId: 'tool-r' });
  const index = new HistoryIndex();
  index.recordSubagentLink('rekey-parent', 'tool-r', 'worker-old', 'builder');
  // Worker compaction rekeys the spawn, repointing the link at the new id.
  index.recordSubagentLink('rekey-parent', 'tool-r', 'worker-new', 'builder');
  index.close();

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  // Both the pre- and post-rekey worker sessions stay hidden; only the parent shows.
  assert.deepEqual(
    rows.map((row) => row.summary.id),
    ['rekey-parent'],
  );
});

test('loadHistoricalSessions keeps forked chats (bare parent, no spawn markers) visible', () => {
  const cwd = join(home, 'workspace-fork');
  writeSession('source-session', cwd);
  // A forked chat carries a `parent` link but no callingSessionId/callingToolUseId;
  // it is a standalone conversation and must stay in history.
  writeSession('forked-session', cwd, { parent: 'source-session' });
  // A real Task subagent (spawn markers present) with a persisted link must still
  // be hidden (it is openable from the parent as a worker).
  writeSession('task-subagent', cwd, {
    parent: 'source-session',
    callingSessionId: 'source-session',
    callingToolUseId: 'tool-9',
  });
  const index = new HistoryIndex();
  index.recordSubagentLink('source-session', 'tool-9', 'task-subagent');
  index.close();

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  assert.deepEqual(rows.map((row) => row.summary.id).sort(), ['forked-session', 'source-session']);
});

test('loadHistoricalSessions returns every session when no limit is requested', () => {
  const cwd = join(home, 'workspace-nolimit');
  for (let i = 0; i < 7; i++) writeSession(`nolimit-${i}`, cwd);

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  assert.equal(rows.filter((row) => row.summary.cwd === cwd).length, 7);
});
