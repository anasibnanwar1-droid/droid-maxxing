import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { HistoryIndex } from './history.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';
import type { ChildSessionSummary, SessionSummary, ServerEvent } from './protocol.js';

type SessionHistoryEvent = Extract<ServerEvent, { type: 'session.history' }>;
type SessionUpdatedEvent = Extract<ServerEvent, { type: 'session.updated' }>;

function isSessionHistory(event: ServerEvent): event is SessionHistoryEvent {
  return event.type === 'session.history';
}

function isSessionUpdated(event: ServerEvent): event is SessionUpdatedEvent {
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
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const index = new HistoryIndex();
    index.syncSummaries([
      {
        ...summary(appSessionId, sessionId),
        compactedFromProviderSessionIds,
      },
    ]);
    index.close();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
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

function summary(appSessionId: string, providerSessionId: string): SessionSummary {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: `Historical ${appSessionId}`,
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

function linkedWorker(
  parentAppSessionId: string,
  childSessionId: string,
  toolUseId: string,
  status: ChildSessionSummary['status'] = 'completed',
): ChildSessionSummary {
  return {
    parentAppSessionId,
    childSessionId,
    role: 'worker',
    status,
    modelId: 'model-default',
    spawnLink: { kind: 'tool-use', id: toolUseId },
    transcriptAvailable: true,
  };
}

test('[H1] Initial history restore', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    writeHistorySession(h.home, 'app-h1', [assistantMessage('m1', 'restored', 0)]);

    await h.handle({ type: 'session.loadHistory', appSessionId: 'app-h1' });

    const event = h.events.filter(isSessionHistory).at(-1);
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

test('[H2] Paging, empty history, and retry', { concurrency: false }, async () => {
  const empty = createSessionManagerTestContext();
  try {
    await empty.create({
      sessionPurpose: 'chat',
      clientRef: 'empty-h2',
      title: 'Empty H2',
      goal: 'go',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    rmSync(path.join(empty.home, '.factory', 'sessions'), { recursive: true, force: true });
    await empty.handle({ type: 'session.loadHistory', appSessionId: 'provider-1' });
    const restored = empty.events.filter(isSessionHistory).at(-1);
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

  const h = createSessionManagerTestContext();
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

    const newest = h.events.filter(isSessionHistory).at(-1);
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

    const oldest = h.events.filter(isSessionHistory).at(-1);
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
    const retried = h.events.filter(isSessionHistory).at(-1);
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
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'a1',
      title: 'A1',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    const parent = h.provider.session('provider-1');
    await parent.waitForPrompts(1);
    await h.waitForIdle();
    parent.queueStreamEvents([
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'tool-a1',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-a1',
          parameters: { subagent_type: 'worker' },
        },
      },
    ]);
    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'spawn worker',
    });

    const persistence = h.calls.find(
      (call) => call.target === 'history' && call.method === 'upsertChildSession',
    )?.args[0];
    assert.ok(persistence && typeof persistence === 'object');
    assert.deepEqual(
      {
        parentAppSessionId: Reflect.get(persistence, 'parentAppSessionId'),
        childSessionId: Reflect.get(persistence, 'childSessionId'),
        providerSessionId: Reflect.get(persistence, 'providerSessionId'),
        role: Reflect.get(persistence, 'role'),
        label: Reflect.get(persistence, 'label'),
        status: Reflect.get(persistence, 'status'),
        modelId: Reflect.get(persistence, 'modelId'),
        spawnLink: Reflect.get(persistence, 'spawnLink'),
        transcriptAvailable: Reflect.get(persistence, 'transcriptAvailable'),
      },
      {
        parentAppSessionId: 'provider-1',
        childSessionId: 'child-1',
        providerSessionId: 'worker-a1',
        role: 'worker',
        label: 'worker',
        status: 'running',
        modelId: 'model-default',
        spawnLink: { kind: 'tool-use', id: 'tool-a1' },
        transcriptAvailable: true,
      },
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'session.child' &&
          event.child.parentAppSessionId === 'provider-1' &&
          event.child.childSessionId === 'child-1' &&
          event.child.status === 'running',
      ),
      true,
    );
  } finally {
    await h.dispose();
  }
});

test('[A1b] child persistence resolves the accepted catalog default when settings are empty', async () => {
  const h = createSessionManagerTestContext({
    getFactoryDefaults: () => Promise.resolve({}),
  });

  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'a1b',
      title: 'A1b',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    const parent = h.provider.session('provider-1');
    await parent.waitForPrompts(1);
    await h.waitForIdle();
    parent.queueStreamEvents([
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'tool-a1b',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-a1b',
          parameters: { subagent_type: 'worker' },
        },
      },
    ]);
    await h.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'spawn worker',
    });

    const persistence = h.calls.find(
      (call) => call.target === 'history' && call.method === 'upsertChildSession',
    )?.args[0];
    assert.ok(persistence && typeof persistence === 'object');
    assert.equal(Reflect.get(persistence, 'childSessionId'), 'child-1');
    assert.equal(Reflect.get(persistence, 'modelId'), 'model-default');
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'error' && event.message.includes('accepted model is unavailable'),
      ),
      false,
    );
  } finally {
    await h.dispose();
  }
});

test('[A1c] provider replacement preserves the logical child identity', async () => {
  const h = createSessionManagerTestContext();

  try {
    await h.create({
      sessionPurpose: 'mission-control',
      clientRef: 'a1c',
      title: 'A1c',
      goal: 'go',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    const parent = h.provider.session('provider-1');
    await parent.waitForPrompts(1);
    await h.waitForIdle();
    const observeProvider = async (providerSessionId: string, text: string): Promise<void> => {
      parent.queueStreamEvents([
        {
          type: 'tool_progress',
          toolName: 'Task',
          toolUseId: 'tool-a1c',
          content: '',
          update: {
            type: 'tool_call',
            subagentSessionId: providerSessionId,
            parameters: { subagent_type: 'worker' },
          },
        },
      ]);
      await h.handle({
        type: 'session.send',
        appSessionId: 'provider-1',
        text,
      });
    };

    await observeProvider('worker-a1c-old', 'spawn worker');
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      requestId: 'open-child-a1c-old',
    });
    await observeProvider('worker-a1c-new', 'replace worker runtime');
    await h.waitForIdle();

    const children = h.history.childSessions('provider-1');
    assert.equal(children.length, 1);
    assert.equal(children[0]?.childSessionId, 'child-1');
    assert.equal(children[0]?.providerSessionId, 'worker-a1c-new');
    assert.equal(
      h.calls.some(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'session.close' &&
          call.args[0] === 'worker-a1c-old',
      ),
      true,
    );

    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      requestId: 'open-child-a1c-new',
    });
    assert.equal(h.runtime.loadCalls.at(-1)?.sessionId, 'worker-a1c-new');
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.updated' &&
          event.requestId === 'open-child-a1c-new' &&
          event.childSessionId === 'child-1' &&
          event.access === 'ready' &&
          event.runtimeGeneration === 4,
      ),
      true,
    );

    await observeProvider('worker-a1c-old', 'late stale worker observation');
    assert.equal(
      h.history.childSession('provider-1', 'child-1')?.providerSessionId,
      'worker-a1c-new',
    );
    assert.equal(
      h.calls.some(
        (call) =>
          call.target === 'cleanup' &&
          call.method === 'session.close' &&
          call.args[0] === 'worker-a1c-new',
      ),
      false,
    );
  } finally {
    await h.dispose();
  }
});

test('[A2] Open and replay a linked child session', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    h.fixture.seedHistorySummaries([summary('app-a2', 'provider-a2')]);
    h.fixture.seedChildSessions([
      linkedWorker('app-a2', 'worker-a2', 'tool-a2', 'paused'),
      linkedWorker('app-a2', 'worker-unknown-a2', 'tool-unknown-a2'),
    ]);
    writeHistorySession(h.home, 'provider-a2', []);
    writeHistorySession(h.home, 'worker-a2', [assistantMessage('child-a2', 'child replay', 0)], {
      callingSessionId: 'provider-a2',
      callingToolUseId: 'tool-a2',
    });

    await h.handle({ type: 'session.loadHistory', appSessionId: 'app-a2' });
    const historical = h.events.filter(isSessionHistory).at(-1);
    assert.ok(historical);
    assert.equal(
      historical.childSessions?.find((child) => child.childSessionId === 'worker-a2')?.status,
      'paused',
    );
    assert.equal(
      historical.childSessions?.find((child) => child.childSessionId === 'worker-unknown-a2')
        ?.status,
      'completed',
    );

    await h.handle({ type: 'session.resume', appSessionId: 'app-a2' });
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'app-a2',
      childSessionId: 'worker-a2',
      requestId: 'open-worker-a2',
    });
    const primary = h.provider.session('provider-a2');
    primary.queueStreamEvents([
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'tool-completed-a2',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-completed-a2',
          parameters: { subagent_type: 'worker' },
        },
      },
      {
        type: 'tool_result',
        toolName: 'Task',
        toolUseId: 'tool-completed-a2',
        content: 'done',
        isError: false,
      },
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'tool-running-a2',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-running-a2',
          parameters: { subagent_type: 'worker' },
        },
      },
    ]);
    await h.handle({
      type: 'session.send',
      appSessionId: 'app-a2',
      text: 'run child',
    });
    await h.handle({ type: 'session.loadHistory', appSessionId: 'app-a2' });

    assert.equal(h.runtime.loadCalls.at(-1)?.sessionId, 'worker-a2');
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.updated' &&
          event.childSessionId === 'worker-a2' &&
          event.access === 'ready',
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
    const live = h.events.filter(isSessionHistory).at(-1);
    assert.ok(live);
    assert.equal(
      live.childSessions?.find((child) => child.childSessionId === 'worker-a2')?.status,
      'paused',
    );
    assert.equal(
      live.childSessions?.find((child) => child.spawnLink?.id === 'tool-completed-a2')?.status,
      'completed',
    );
    assert.equal(
      live.childSessions?.find((child) => child.spawnLink?.id === 'tool-running-a2')?.status,
      'running',
    );
    assert.equal(
      live.childSessions?.find((child) => child.childSessionId === 'worker-unknown-a2')?.status,
      'completed',
    );
  } finally {
    await h.dispose();
  }
});

test('[A3] Child send, steer, and interrupt', { concurrency: false }, async () => {
  const h = createSessionManagerTestContext();

  try {
    h.fixture.seedHistorySummaries([summary('app-a3', 'provider-a3')]);
    h.fixture.seedChildSessions([
      linkedWorker('app-a3', 'worker-a3', 'tool-a3', 'paused'),
      linkedWorker('app-a3', 'worker-failed-a3', 'tool-failed-a3', 'paused'),
    ]);

    await h.handle({ type: 'session.resume', appSessionId: 'app-a3' });
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-a3',
      requestId: 'open-worker-a3',
    });

    const gate = h.provider.deferNextStream('worker-a3');
    const sending = h.handle({
      type: 'child.send',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-a3',
      text: 'normal',
    });
    await h.provider.waitForPrompts('worker-a3', 1);
    await h.handle({
      type: 'child.sendNow',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-a3',
      text: 'steer',
    });
    gate.resolve();
    await sending;
    await h.provider.waitForPrompts('worker-a3', 2);
    await h.handle({
      type: 'child.interrupt',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-a3',
    });

    const parentUpdates = h.events.filter(
      (event) => isSessionUpdated(event) && event.session.appSessionId === 'app-a3',
    );
    h.runtime.loadQueue.set('worker-failed-a3', [new Error('child load failed')]);
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-failed-a3',
      requestId: 'open-worker-failed-a3',
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
          event.type === 'child.error' &&
          event.code === 'child.open_failed' &&
          event.parentAppSessionId === 'app-a3' &&
          event.childSessionId === 'worker-failed-a3',
      ),
      true,
    );
    const loadCallCount = h.runtime.loadCalls.length;
    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'app-a3',
      childSessionId: 'worker-unknown-a3',
      requestId: 'open-worker-unknown-a3',
    });
    assert.equal(h.runtime.loadCalls.length, loadCallCount);
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.error' &&
          event.code === 'child.not_in_session' &&
          event.childSessionId === 'worker-unknown-a3',
      ),
      true,
    );
    assert.equal(
      h.events.some(
        (event) => event.type === 'child.updated' && event.childSessionId === 'worker-unknown-a3',
      ),
      false,
    );
    assert.deepEqual(
      h.events.filter(
        (event) => isSessionUpdated(event) && event.session.appSessionId === 'app-a3',
      ),
      parentUpdates,
    );
  } finally {
    await h.dispose();
  }
});

test('[A4] Opening a child for a non-live historical session settles honestly', async () => {
  const h = createSessionManagerTestContext();

  try {
    h.fixture.seedHistorySummaries([summary('app-a4', 'provider-a4')]);
    h.fixture.seedChildSessions([linkedWorker('app-a4', 'worker-a4', 'tool-a4')]);

    await h.handle({
      type: 'child.open',
      parentAppSessionId: 'app-a4',
      childSessionId: 'worker-a4',
      requestId: 'open-worker-a4',
    });

    assert.equal(h.runtime.loadCalls.length, 0);
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.updated' &&
          event.parentAppSessionId === 'app-a4' &&
          event.childSessionId === 'worker-a4' &&
          event.access === 'history',
      ),
      true,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.error' &&
          event.parentAppSessionId === 'app-a4' &&
          event.childSessionId === 'worker-a4',
      ),
      false,
    );
  } finally {
    await h.dispose();
  }
});
