import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary } from './protocol.js';

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

function summary(appSessionId: string, cwd: string): SessionSummary {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId: appSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: 'Plain chat',
    goal: 'Plain chat',
    cwd,
    workspaceKind: cwd ? 'folder' : 'none',
    autonomy: 'low',
    phase: 'paused',
    streaming: false,
    compacting: false,
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
    rows.map((row) => row.summary.appSessionId),
    ['plain-runtime-home'],
  );
  assert.equal(rows[0].summary.cwd, '');
  assert.equal(rows[0].summary.workspaceKind, 'none');
});

test('syncSummaries persists autoCompactions and loadHistoricalSessions restores it', () => {
  const cwd = join(home, 'workspace-autocompact');
  writeSession('autocompact-chat', cwd);
  const index = new HistoryIndex();
  index.syncSummaries([{ ...summary('autocompact-chat', cwd), autoCompactions: 3 }]);
  index.close();

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  const row = rows.find((r) => r.summary.appSessionId === 'autocompact-chat');
  assert.equal(row?.summary.autoCompactions, 3);
});

test('loadHistoricalSessions hides a Task-spawned child from its raw parent link', () => {
  const cwd = join(home, 'workspace-child');
  writeSession('real-session', cwd);
  writeSession('child-session', cwd, {
    callingSessionId: 'real-session',
    callingToolUseId: 'tool-1',
  });
  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  assert.deepEqual(
    rows.map((row) => row.summary.appSessionId),
    ['real-session'],
  );
});

test('loadHistoricalSessions hides a Task child session even when its link is missing', () => {
  const cwd = join(home, 'workspace-orphan');
  writeSession('orphan-parent', cwd);
  // Task children never appear as top-level sessions. A missing canonical link
  // is an invalid local state, not a second history behavior.
  writeSession('orphan-child', cwd, {
    callingSessionId: 'orphan-parent',
    callingToolUseId: 'tool-7',
  });

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  assert.deepEqual(
    rows.map((row) => row.summary.appSessionId),
    ['orphan-parent'],
  );
});

test('loadHistoricalSessions keeps a rekeyed worker hidden under its superseded id', () => {
  const cwd = join(home, 'workspace-rekey');
  writeSession('rekey-parent', cwd);
  writeSession('worker-old', cwd, { callingSessionId: 'rekey-parent', callingToolUseId: 'tool-r' });
  writeSession('worker-new', cwd, { callingSessionId: 'rekey-parent', callingToolUseId: 'tool-r' });

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  // Both the pre- and post-rekey worker sessions stay hidden; only the parent shows.
  assert.deepEqual(
    rows.map((row) => row.summary.appSessionId),
    ['rekey-parent'],
  );
});

test('loadHistoricalSessions keeps forked chats (bare parent, no spawn markers) visible', () => {
  const cwd = join(home, 'workspace-fork');
  writeSession('source-session', cwd);
  // A forked chat carries a `parent` link but no callingSessionId/callingToolUseId;
  // it is a standalone conversation and must stay in history.
  writeSession('forked-session', cwd, { parent: 'source-session' });
  // A real Task child (spawn markers present) must still be hidden.
  writeSession('task-child', cwd, {
    parent: 'source-session',
    callingSessionId: 'source-session',
    callingToolUseId: 'tool-9',
  });
  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  assert.deepEqual(rows.map((row) => row.summary.appSessionId).sort(), [
    'forked-session',
    'source-session',
  ]);
});

test('loadHistoricalSessions returns every session when no limit is requested', () => {
  const cwd = join(home, 'workspace-nolimit');
  for (let i = 0; i < 7; i++) writeSession(`nolimit-${i}`, cwd);

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  assert.equal(rows.filter((row) => row.summary.cwd === cwd).length, 7);
});
