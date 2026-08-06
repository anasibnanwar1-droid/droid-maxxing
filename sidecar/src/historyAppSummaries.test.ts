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

test('historical compaction markers hydrate the summary generation', () => {
  const cwd = join(home, 'workspace-external-compactions');
  writeSession('external-compactions', cwd);
  const index = new HistoryIndex();
  index.syncSummaries([summary('external-compactions', cwd)]);
  for (let i = 0; i < 4; i++) {
    index.recordEvent({
      id: `external-compaction-${String(i)}`,
      appSessionId: 'external-compactions',
      sourceSessionId: 'primary',
      role: 'primary',
      kind: 'compaction',
      ts: i,
    });
    index.recordEvent({
      id: `compaction-external-compactions-summary-${String(i)}`,
      appSessionId: 'external-compactions',
      sourceSessionId: 'external-compactions',
      role: 'primary',
      kind: 'compaction',
      ts: i,
    });
  }
  index.recordEvent({
    id: 'compaction-worker-summary',
    appSessionId: 'external-compactions',
    sourceSessionId: 'worker-1',
    role: 'worker',
    kind: 'compaction',
    ts: 5,
  });
  index.close();

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  const row = rows.find((item) => item.summary.appSessionId === 'external-compactions');
  assert.equal(row?.summary.autoCompactions, 4);
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

test('summaryPatchesAndHidden derives patches and hidden ids from one read', () => {
  const cwd = join(home, 'workspace-combined-read');
  writeSession('cur-1', cwd);
  const index = new HistoryIndex();
  index.syncSummaries([
    {
      ...summary('app-1', cwd),
      providerSessionId: 'cur-1',
      compactedFromProviderSessionIds: ['old-1'],
      tokensIn: 20,
      contextTokens: 800,
    },
  ]);
  for (let i = 0; i < 2; i++) {
    index.recordEvent({
      id: `compaction-app-1-${String(i)}`,
      appSessionId: 'app-1',
      sourceSessionId: 'app-1',
      role: 'primary',
      kind: 'compaction',
      ts: i,
    });
  }
  try {
    const { patches, hiddenProviderSessionIds } = index.summaryPatchesAndHidden();
    assert.equal(patches.get('app-1')?.providerSessionId, 'cur-1');
    assert.equal(patches.get('cur-1')?.tokensIn, 20);
    assert.equal(patches.get('cur-1')?.contextTokens, 800);
    assert.equal(patches.get('app-1')?.autoCompactions, 2);
    assert.deepEqual([...hiddenProviderSessionIds], ['old-1']);
  } finally {
    index.close();
  }
});
