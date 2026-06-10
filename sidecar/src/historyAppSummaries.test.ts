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

  assert.deepEqual(rows.map((row) => row.summary.id), ['plain-runtime-home']);
  assert.equal(rows[0].summary.cwd, '');
  assert.equal(rows[0].summary.workspaceKind, 'none');
});

test('loadHistoricalSessions skips Task-spawned subagent sessions', () => {
  const cwd = join(home, 'workspace-subagent');
  writeSession('real-session', cwd);
  writeSession('subagent-session', cwd, { callingSessionId: 'real-session', callingToolUseId: 'tool-1' });

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  assert.deepEqual(rows.map((row) => row.summary.id), ['real-session']);
});

test('loadHistoricalSessions returns every session when no limit is requested', () => {
  const cwd = join(home, 'workspace-nolimit');
  for (let i = 0; i < 7; i++) writeSession(`nolimit-${i}`, cwd);

  const rows = loadHistoricalSessions({ workspaceCwds: [cwd] });

  assert.equal(rows.filter((row) => row.summary.cwd === cwd).length, 7);
});
