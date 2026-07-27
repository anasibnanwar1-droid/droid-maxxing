import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';

import { createSessionCharacterizationHarness } from './testing/sessionCharacterizationHarness.js';
import type { SessionSummary, ServerEvent, ChildSessionHistoryLink } from './protocol.js';

type MissionHistoryEvent = Extract<ServerEvent, { type: 'session.history' }>;
type MissionUpdatedEvent = Extract<ServerEvent, { type: 'session.updated' }>;

function isMissionHistory(event: ServerEvent): event is MissionHistoryEvent {
  return event.type === 'session.history';
}

function isMissionUpdated(event: ServerEvent): event is MissionUpdatedEvent {
  return event.type === 'session.updated';
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
  compactedFromProviderSessionIds: string[],
): void {
  const dir = path.join(home, '.factory', 'droid-control');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'index.sqlite'));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        app_session_id TEXT PRIMARY KEY,
        provider_session_id TEXT NOT NULL,
        compacted_from_provider_session_ids TEXT NOT NULL,
        session_purpose TEXT NOT NULL,
        interaction_mode TEXT NOT NULL,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO app_sessions (
        app_session_id, provider_session_id, compacted_from_provider_session_ids,
        session_purpose, interaction_mode, title, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      appSessionId,
      sessionId,
      JSON.stringify(compactedFromProviderSessionIds),
      'chat',
      'auto',
      'History',
      0,
    );
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

function summary(id: string, sessionId: string): SessionSummary {
  const now = Date.now();
  return {
    appSessionId: id,
    providerSessionId: sessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
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

function linkedWorker(providerSessionId: string, toolUseId: string): ChildSessionHistoryLink {
  return { providerSessionId, toolUseId };
}

test('[H1] Initial history restore', { concurrency: false }, async () => {
  const h = createSessionCharacterizationHarness();

  try {
    writeHistorySession(h.home, 'app-h1', [assistantMessage('m1', 'restored', 0)]);

    await h.handle({ type: 'session.loadHistory', appSessionId: 'app-h1' });

    const event = h.events.filter(isMissionHistory).at(-1);
    assert.ok(event);
    assert.equal(event.appSessionId, 'app-h1');
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
    await empty.handle({ type: 'session.loadHistory', appSessionId: 'provider-1' });
    const restored = empty.events.filter(isMissionHistory).at(-1);
    assert.ok(restored);
    assert.equal(restored.mode, 'replace');
    assert.deepEqual(restored.transcripts, []);
    assert.equal(restored.hasMore, false);
    assert.equal(
      empty.events.some(
        (event) => event.type === 'session.history.error' && event.appSessionId === 'provider-1',
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

    await h.handle({ type: 'session.loadHistory', appSessionId: 'app-h2' });

    const newest = h.events.filter(isMissionHistory).at(-1);
    assert.ok(newest);
    assert.equal(newest.mode, 'replace');
    assert.equal(newest.transcripts.length, 400);
    assert.equal(newest.transcripts[0]?.text, 'new-0');
    assert.ok(newest.olderCursor);
    assert.equal(newest.hasMore, true);

    await h.handle({
      type: 'session.loadHistory',
      appSessionId: 'app-h2',
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

    await h.handle({ type: 'session.loadHistory', appSessionId: 'missing-h2' });
    const historyErrors = h.events.filter(
      (event) => event.type === 'session.history.error' && event.appSessionId === 'missing-h2',
    ).length;
    assert.equal(historyErrors, 1);
    assert.equal(
      h.events.some((event) => event.type === 'error' && event.appSessionId === 'missing-h2'),
      true,
    );

    writeHistorySession(h.home, 'missing-h2', [assistantMessage('retry', 'retried', 402)]);
    await h.handle({ type: 'session.loadHistory', appSessionId: 'missing-h2' });
    const retried = h.events.filter(isMissionHistory).at(-1);
    assert.ok(retried);
    assert.equal(retried.mode, 'replace');
    assert.equal(retried.transcripts[0]?.text, 'retried');
    assert.equal(
      h.events.filter(
        (event) => event.type === 'session.history.error' && event.appSessionId === 'missing-h2',
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
      type: 'child.open',
      appSessionId: 'provider-1',
      providerSessionId: 'provider-1',
      role: 'primary',
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
          event.type === 'session.child' &&
          event.appSessionId === 'provider-1' &&
          event.providerSessionId === 'worker-a1' &&
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

    await h.handle({ type: 'session.resume', appSessionId: 'app-a2' });
    await h.handle({
      type: 'child.open',
      appSessionId: 'app-a2',
      providerSessionId: 'worker-a2',
      role: 'worker',
    });

    assert.equal(h.runtime.loadCalls.at(-1)?.sessionId, 'worker-a2');
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.updated' &&
          event.providerSessionId === 'worker-a2' &&
          event.status === 'opened',
      ),
      true,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'event.appended' &&
          event.event.sourceSessionId === 'worker-a2' &&
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

    await h.handle({ type: 'session.resume', appSessionId: 'app-a3' });
    await h.handle({
      type: 'child.open',
      appSessionId: 'app-a3',
      providerSessionId: 'worker-a3',
      role: 'worker',
    });

    const gate = h.provider.deferNextStream('worker-a3');
    const sending = h.handle({
      type: 'child.send',
      appSessionId: 'app-a3',
      providerSessionId: 'worker-a3',
      text: 'normal',
    });
    await h.provider.waitForPrompts('worker-a3', 1);
    await h.handle({
      type: 'child.sendNow',
      appSessionId: 'app-a3',
      providerSessionId: 'worker-a3',
      text: 'steer',
    });
    gate.resolve();
    await sending;
    await h.provider.waitForPrompts('worker-a3', 2);
    await h.handle({
      type: 'child.interrupt',
      appSessionId: 'app-a3',
      providerSessionId: 'worker-a3',
    });

    const parentUpdates = h.events.filter(
      (event) => isMissionUpdated(event) && event.session.appSessionId === 'app-a3',
    );
    h.runtime.loadQueue.set('worker-failed-a3', [new Error('child load failed')]);
    await h.handle({
      type: 'child.open',
      appSessionId: 'app-a3',
      providerSessionId: 'worker-failed-a3',
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
          event.providerSessionId === 'worker-failed-a3',
      ),
      true,
    );
    assert.deepEqual(
      h.events.filter(
        (event) => isMissionUpdated(event) && event.session.appSessionId === 'app-a3',
      ),
      parentUpdates,
    );
  } finally {
    await h.dispose();
  }
});
