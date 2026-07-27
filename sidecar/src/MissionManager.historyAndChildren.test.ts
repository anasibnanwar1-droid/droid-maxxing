import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';

import { createSessionCharacterizationHarness } from './testing/sessionCharacterizationHarness.js';
import type { MissionSummary, ServerEvent, WorkerHistoryLink } from './protocol.js';

type MissionHistoryEvent = Extract<ServerEvent, { type: 'mission.history' }>;
type MissionUpdatedEvent = Extract<ServerEvent, { type: 'mission.updated' }>;

function isMissionHistory(event: ServerEvent): event is MissionHistoryEvent {
  return event.type === 'mission.history';
}

function isMissionUpdated(event: ServerEvent): event is MissionUpdatedEvent {
  return event.type === 'mission.updated';
}

function writeHistorySession(
  home: string,
  id: string,
  lines: unknown[],
  sessionStart: Record<string, unknown> = {},
): void {
  const dir = path.join(home, '.factory', 'sessions', '2026', '07');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${id}.jsonl`),
    [
      JSON.stringify({
        type: 'session_start',
        id,
        cwd: home,
        sessionTitle: 'History',
        settings: { interactionMode: 'auto' },
        ...sessionStart,
      }),
      ...lines.map((line) => JSON.stringify(line)),
    ].join('\n') + '\n',
  );
}

function writeHistoryChain(
  home: string,
  appSessionId: string,
  sessionId: string,
  compactedFromSessionIds: string[],
): void {
  const dir = path.join(home, '.factory', 'droid-control');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'index.sqlite'));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        app_session_id TEXT PRIMARY KEY,
        droid_session_id TEXT NOT NULL,
        previous_droid_session_ids TEXT NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO app_sessions (
        app_session_id, droid_session_id, previous_droid_session_ids, kind, title, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(appSessionId, sessionId, JSON.stringify(compactedFromSessionIds), 'chat', 'History', 0);
  } finally {
    db.close();
  }
}

function assistantMessage(id: string, text: string, timestamp: number): Record<string, unknown> {
  return {
    type: 'message',
    id,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function summary(id: string, sessionId: string): MissionSummary {
  const now = Date.now();
  return {
    id,
    sessionId,
    kind: 'chat',
    role: 'orchestrator',
    title: `Historical ${id}`,
    goal: '',
    cwd: '',
    workspaceKind: 'none',
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

function linkedWorker(workerSessionId: string, toolUseId: string): WorkerHistoryLink {
  return { workerSessionId, toolUseId };
}

test('[H1] Initial history restore', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    writeHistorySession(h.home, 'app-h1', [assistantMessage('m1', 'restored', 0)]);

    await h.handle({ type: 'mission.loadHistory', missionId: 'app-h1' });

    const event = h.events.filter(isMissionHistory).at(-1);
    assert.ok(event);
    assert.equal(event.missionId, 'app-h1');
    assert.equal(event.mode, 'replace');
    assert.equal(event.transcripts[0]?.text, 'restored');
    assert.equal(
      h.calls.filter((call) => call.target === 'history' && call.method === 'recordEvent').length,
      1,
    );
  } finally {
    await h.dispose();
  }
});

test('[H2] Paging, fallback, empty history, and retry', { concurrency: false }, async () => {
  const empty = createSessionCharacterizationHarness();
  try {
    await empty.create({
      clientRef: 'empty-h2',
      title: 'Empty H2',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    rmSync(path.join(empty.home, '.factory', 'sessions'), { recursive: true, force: true });
    await empty.handle({ type: 'mission.loadHistory', missionId: 'provider-1' });
    const restored = empty.events.filter(isMissionHistory).at(-1);
    assert.ok(restored);
    assert.equal(restored.mode, 'replace');
    assert.deepEqual(restored.transcripts, []);
    assert.equal(restored.hasMore, false);
    assert.equal(
      empty.events.some(
        (event) => event.type === 'mission.history.error' && event.missionId === 'provider-1',
      ),
      false,
    );
  } finally {
    await empty.dispose();
  }

  const h = createSessionCharacterizationHarness();
  try {
    writeHistorySession(h.home, 'old-h2', [assistantMessage('old', 'old', 0)]);
    writeHistorySession(
      h.home,
      'new-h2',
      Array.from({ length: 400 }, (_, index) =>
        assistantMessage(`new-${index}`, `new-${index}`, index + 1),
      ),
    );
    writeHistoryChain(h.home, 'app-h2', 'new-h2', ['old-h2']);

    await h.handle({ type: 'mission.loadHistory', missionId: 'app-h2' });

    const newest = h.events.filter(isMissionHistory).at(-1);
    assert.ok(newest);
    assert.equal(newest.mode, 'replace');
    assert.equal(newest.transcripts.length, 400);
    assert.equal(newest.transcripts[0]?.text, 'new-0');
    assert.ok(newest.olderCursor);
    assert.equal(newest.hasMore, true);

    await h.handle({
      type: 'mission.loadHistory',
      missionId: 'app-h2',
      cursor: newest.olderCursor,
    });

    const oldest = h.events.filter(isMissionHistory).at(-1);
    assert.ok(oldest);
    assert.equal(oldest.mode, 'prepend');
    assert.equal(oldest.transcripts.length, 1);
    assert.equal(oldest.transcripts[0]?.text, 'old');
    assert.equal(oldest.hasMore, false);
    assert.equal(
      h.calls.filter((call) => call.target === 'history' && call.method === 'recordEvent').length,
      401,
    );

    await h.handle({ type: 'mission.loadHistory', missionId: 'missing-h2' });
    const historyErrors = h.events.filter(
      (event) => event.type === 'mission.history.error' && event.missionId === 'missing-h2',
    ).length;
    assert.equal(historyErrors, 1);
    assert.equal(
      h.events.some((event) => event.type === 'error' && event.missionId === 'missing-h2'),
      true,
    );
    assert.equal(
      h.events.some((event) => event.type === 'mission.error' && event.missionId === 'missing-h2'),
      false,
    );

    writeHistorySession(h.home, 'missing-h2', [assistantMessage('retry', 'retried', 402)]);
    await h.handle({ type: 'mission.loadHistory', missionId: 'missing-h2' });
    const retried = h.events.filter(isMissionHistory).at(-1);
    assert.ok(retried);
    assert.equal(retried.mode, 'replace');
    assert.equal(retried.transcripts[0]?.text, 'retried');
    assert.equal(
      h.events.filter(
        (event) => event.type === 'mission.history.error' && event.missionId === 'missing-h2',
      ).length,
      historyErrors,
    );
  } finally {
    await h.dispose();
  }
});

test('[A1] Child-session link persistence', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    await h.create({
      clientRef: 'a1',
      title: 'A1',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await h.handle({
      type: 'agent.open',
      missionId: 'provider-1',
      agentSessionId: 'provider-1',
      role: 'orchestrator',
    });
    h.provider.emitNotification('provider-1', {
      type: 'tool_progress_update',
      toolName: 'Task',
      toolUseId: 'tool-a1',
      update: {
        type: 'tool_call',
        subagentSessionId: 'worker-a1',
        parameters: { subagent_type: 'worker' },
      },
    });

    assert.deepEqual(
      h.calls.find((call) => call.target === 'history' && call.method === 'recordSubagentLink')
        ?.args,
      ['provider-1', 'tool-a1', 'worker-a1', 'worker'],
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'mission.worker' &&
          event.missionId === 'provider-1' &&
          event.workerSessionId === 'worker-a1' &&
          event.event === 'started',
      ),
      true,
    );
  } finally {
    await h.dispose();
  }
});

test('[A2] Open and replay a linked child session', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    h.fixture.seedHistorySummaries([summary('app-a2', 'provider-a2')]);
    h.fixture.seedSubagentLinks('app-a2', [linkedWorker('worker-a2', 'tool-a2')]);
    writeHistorySession(h.home, 'worker-a2', [assistantMessage('child-a2', 'child replay', 0)], {
      callingSessionId: 'provider-a2',
      callingToolUseId: 'tool-a2',
    });

    await h.handle({ type: 'mission.resume', sessionId: 'app-a2' });
    await h.handle({
      type: 'agent.open',
      missionId: 'app-a2',
      agentSessionId: 'worker-a2',
      role: 'worker',
    });

    assert.equal(h.runtime.loadCalls.at(-1)?.sessionId, 'worker-a2');
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'agent.updated' &&
          event.agentSessionId === 'worker-a2' &&
          event.status === 'opened',
      ),
      true,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'mission.transcript' &&
          event.event.agentSessionId === 'worker-a2' &&
          event.event.text === 'child replay',
      ),
      true,
    );
  } finally {
    await h.dispose();
  }
});

test('[A3] Child send, steer, and interrupt', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    h.fixture.seedHistorySummaries([summary('app-a3', 'provider-a3')]);
    h.fixture.seedSubagentLinks('app-a3', [
      linkedWorker('worker-a3', 'tool-a3'),
      linkedWorker('worker-failed-a3', 'tool-failed-a3'),
    ]);

    await h.handle({ type: 'mission.resume', sessionId: 'app-a3' });
    await h.handle({
      type: 'agent.open',
      missionId: 'app-a3',
      agentSessionId: 'worker-a3',
      role: 'worker',
    });

    const gate = h.provider.deferNextStream('worker-a3');
    const sending = h.handle({
      type: 'agent.send',
      missionId: 'app-a3',
      agentSessionId: 'worker-a3',
      text: 'normal',
    });
    await h.provider.waitForPrompts('worker-a3', 1);
    await h.handle({
      type: 'agent.sendNow',
      missionId: 'app-a3',
      agentSessionId: 'worker-a3',
      text: 'steer',
    });
    gate.resolve();
    await sending;
    await h.provider.waitForPrompts('worker-a3', 2);
    await h.handle({
      type: 'agent.interrupt',
      missionId: 'app-a3',
      agentSessionId: 'worker-a3',
    });

    const parentUpdates = h.events.filter(
      (event) => isMissionUpdated(event) && event.mission.id === 'app-a3',
    );
    h.runtime.loadQueue.set('worker-failed-a3', [new Error('child load failed')]);
    await h.handle({
      type: 'agent.open',
      missionId: 'app-a3',
      agentSessionId: 'worker-failed-a3',
      role: 'worker',
    });

    assert.deepEqual(h.provider.session('worker-a3').prompts, ['normal', 'steer']);
    assert.equal(
      h.calls.filter(
        (call) =>
          call.target === 'provider' && call.method === 'interrupt' && call.args[0] === 'worker-a3',
      ).length,
      2,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' &&
          event.code === 'agent.open_failed' &&
          event.sessionId === 'worker-failed-a3',
      ),
      true,
    );
    assert.deepEqual(
      h.events.filter((event) => isMissionUpdated(event) && event.mission.id === 'app-a3'),
      parentUpdates,
    );
  } finally {
    await h.dispose();
  }
});
