import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReasoningEffort,
  type AskUserResult,
  type RequestPermissionHandlerResult,
} from '@factory/droid-sdk';

import { ChildSessions } from './ChildSessions.js';
import type { ChildSessionsDependencies } from './ChildSessionsTypes.js';
import type { ChildParentLease } from './ChildSessionState.js';
import type { PersistedChildSession } from './history.js';
import type {
  AutoCompactionSettlement,
  ChildAutomaticCompactionTarget,
} from './SessionCompaction.js';
import type { ServerEvent, SessionSummary } from './protocol.js';
import {
  FakeFactoryRuntime,
  FakeFactorySession,
  type RecordedCall,
  type StreamGate,
} from './testing/fakeFactoryRuntime.js';
import { FakeHistoryIndex } from './testing/historyCharacterizationSupport.js';

interface Harness {
  calls: RecordedCall[];
  events: ServerEvent[];
  history: FakeHistoryIndex;
  runtime: FakeFactoryRuntime;
  owner: ChildSessions;
  parentId: string;
  replaceParent(): void;
  open(record: PersistedChildSession, session?: FakeFactorySession): Promise<FakeFactorySession>;
  target(childSessionId: string): ChildAutomaticCompactionTarget;
}

function createHarness(
  records: PersistedChildSession[],
  options: {
    maxOpenSessions?: number;
    failForgetChild?: string;
    failDriveSetup?: 'beginTurn' | 'commit' | 'startPolling';
    failReplayChild?: boolean;
  } = {},
): Harness {
  const calls: RecordedCall[] = [];
  const events: ServerEvent[] = [];
  const history = new FakeHistoryIndex(calls);
  const runtime = new FakeFactoryRuntime(calls);
  const parentId = 'parent';
  let failReplayChild = options.failReplayChild;
  let failDriveSetup = options.failDriveSetup;
  const throwDriveSetup = (stage: NonNullable<typeof options.failDriveSetup>) => {
    if (failDriveSetup !== stage) return;
    failDriveSetup = undefined;
    throw new Error(`${stage} failed`);
  };
  const upsertChildSession = history.upsertChildSession.bind(history);
  history.upsertChildSession = (child) => {
    if (child.status === 'running') throwDriveSetup('commit');
    upsertChildSession(child);
  };
  history.seedChildSessions(records);
  let parent = parentLease(parentId, calls);
  const dependencies: ChildSessionsDependencies = {
    runtime,
    registry: { getLive: (id) => (id === parentId ? parent : undefined) },
    history,
    timeline: {
      append: (event) => {
        calls.push({ target: 'protocol', method: 'timeline.append', args: [event] });
      },
      appendStatus: (...args) => {
        calls.push({ target: 'protocol', method: 'timeline.status', args });
      },
      replayChild: (...args) => {
        if (failReplayChild) {
          failReplayChild = false;
          throw new Error('replay failed');
        }
        calls.push({ target: 'protocol', method: 'timeline.replayChild', args });
      },
    },
    eventFlow: {
      beginTurn: (...args) => {
        throwDriveSetup('beginTurn');
        calls.push({ target: 'protocol', method: 'turn.begin', args });
      },
      applyNotification: (...args) => {
        calls.push({ target: 'protocol', method: 'notification.apply', args });
      },
      applyStreamEvent: () => undefined,
    },
    interactions: {
      makePermissionHandler: () => () =>
        new Promise<RequestPermissionHandlerResult>(() => undefined),
      makeAskUserHandler: () => () => new Promise<AskUserResult>(() => undefined),
    },
    context: {
      forgetChild: (identity) => {
        if (identity.childSessionId === options.failForgetChild) throw new Error('forget failed');
        calls.push({
          target: 'cleanup',
          method: 'context.forgetChild',
          args: [identity.childSessionId],
        });
      },
      refresh: () => Promise.resolve(),
      startPolling: () => throwDriveSetup('startPolling'),
      stopPolling: (target) => {
        calls.push({
          target: 'cleanup',
          method: 'context.stopPolling',
          args: [target.sourceSessionId],
        });
      },
    },
    compaction: {
      afterTurn: () => undefined,
      arm: () => Promise.resolve(true),
      cancel: (target) => {
        if (target.kind === 'child') target.setAutoCompacting(false);
      },
      handleChildNotification: (_target, note) => {
        calls.push({ target: 'protocol', method: 'compaction.notification', args: [note] });
        return false;
      },
      rearmModelChangedChild: () => Promise.resolve(),
      resolveLimit: () => Promise.resolve(800),
    },
    resolveDefaultSettings: () => ({
      modelId: 'model-default',
      reasoningEffort: ReasoningEffort.Low,
    }),
    isShutdownStarted: () => false,
    emit: (event) => events.push(event),
    nextChildSessionId: () => 'generated-child',
    maxOpenSessions: options.maxOpenSessions ?? 4,
    now: () => 100,
  };
  const owner = new ChildSessions(dependencies);
  owner.attachParent(parentId);
  const harness: Harness = {
    calls,
    events,
    history,
    runtime,
    owner,
    parentId,
    replaceParent: () => {
      parent = parentLease(parentId, calls);
      owner.attachParent(parentId);
    },
    open: async (
      record,
      session = new FakeFactorySession(record.providerSessionId!, {}, calls),
    ) => {
      runtime.loadQueue.set(record.providerSessionId!, [session]);
      await owner.open({
        type: 'child.open',
        parentAppSessionId: record.parentAppSessionId,
        childSessionId: record.childSessionId,
        requestId: `open-${record.childSessionId}`,
      });
      return session;
    },
    target: (childSessionId) => {
      const target = owner
        .compactionRetuneTargets()
        .find(
          (candidate) => candidate.kind === 'child' && candidate.childSessionId === childSessionId,
        );
      assert.ok(target?.kind === 'child');
      return target;
    },
  };
  return harness;
}

function parentLease(appSessionId: string, calls: RecordedCall[]): ChildParentLease {
  return {
    summary: summary(appSessionId),
    session: new FakeFactorySession(`${appSessionId}-provider`, {}, calls),
  };
}

function summary(appSessionId: string): SessionSummary {
  return {
    appSessionId,
    providerSessionId: `${appSessionId}-provider`,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'user',
    title: appSessionId,
    goal: 'test',
    cwd: '/workspace',
    workspaceKind: 'folder',
    modelId: 'model-default',
    reasoningEffort: ReasoningEffort.Low,
    autonomy: 'low',
    phase: 'paused',
    compacting: false,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function childRecord(
  childSessionId: string,
  providerSessionId: string,
  toolUseId = `tool-${childSessionId}`,
): PersistedChildSession {
  return {
    parentAppSessionId: 'parent',
    childSessionId,
    providerSessionId,
    role: 'worker',
    status: 'paused',
    modelId: 'model-default',
    spawnLink: { kind: 'tool-use', id: toolUseId },
    transcriptAvailable: true,
    updatedAt: 1,
  };
}

function settlement(target: ChildAutomaticCompactionTarget): AutoCompactionSettlement {
  return {
    kind: 'child',
    parentAppSessionId: target.parentAppSessionId,
    childSessionId: target.childSessionId,
    parentGeneration: target.parentGeneration,
    runtimeGeneration: target.runtimeGeneration,
    turnGeneration: target.turnGeneration,
    configurationGeneration: target.configurationGeneration,
  };
}

function mutationCount(h: Harness): number {
  return (
    h.events.length +
    h.calls.filter((call) => call.target === 'history' && call.method === 'upsertChildSession')
      .length
  );
}

async function queueForAutomaticSettlement(
  h: Harness,
  childSessionId: string,
): Promise<{
  runtime: FakeFactorySession;
  target: ChildAutomaticCompactionTarget;
  settlement: AutoCompactionSettlement;
}> {
  const record = h.history.childSession(h.parentId, childSessionId);
  assert.ok(record);
  const runtime = await h.open(record);
  const target = h.target(childSessionId);
  target.setAutoCompacting(true);
  await h.owner.send({ parentAppSessionId: h.parentId, childSessionId }, 'must remain queued');
  return { runtime, target, settlement: settlement(target) };
}

test('stale automatic settlement cannot cross owner generation changes', async () => {
  for (const kind of ['parent', 'runtime', 'turn', 'configuration'] as const) {
    const record = childRecord('child', 'provider-old');
    const h = createHarness([record]);
    const captured = await queueForAutomaticSettlement(h, record.childSessionId);
    let currentRuntime = captured.runtime;
    let activeTurn: Promise<void> | undefined;
    let activeGate: StreamGate | undefined;

    if (kind === 'parent') {
      await h.owner.closeParent(h.parentId);
      h.replaceParent();
      currentRuntime = await h.open(record, new FakeFactorySession('provider-old', {}, h.calls));
      const current = h.target(record.childSessionId);
      current.setAutoCompacting(true);
      await h.owner.send(record, 'new parent queue');
    } else if (kind === 'runtime') {
      h.owner.admitChildObservation({
        parentAppSessionId: h.parentId,
        providerSessionId: 'provider-new',
        role: 'worker',
        spawnLink: { kind: 'tool-use', id: `tool-${record.childSessionId}` },
      });
      const replacement = { ...record, providerSessionId: 'provider-new' };
      currentRuntime = await h.open(
        replacement,
        new FakeFactorySession('provider-new', {}, h.calls),
      );
      const current = h.target(record.childSessionId);
      current.setAutoCompacting(true);
      await h.owner.send(record, 'new runtime queue');
    } else if (kind === 'turn') {
      captured.target.setAutoCompacting(false);
      activeGate = currentRuntime.deferNextStream();
      activeTurn = h.owner.send(record, 'active turn');
      await currentRuntime.waitForPrompts(1);
    } else {
      await h.owner.updateSettings({
        type: 'child.updateSettings',
        parentAppSessionId: h.parentId,
        childSessionId: record.childSessionId,
        modelId: 'model-new',
      });
      h.target(record.childSessionId).setAutoCompacting(true);
    }

    const before = mutationCount(h);
    const prompts = currentRuntime.prompts.length;
    const summaryBefore = h.owner.list(h.parentId);
    h.owner.settleAutomatic(captured.settlement);
    await Promise.resolve();

    assert.equal(mutationCount(h), before, kind);
    assert.equal(currentRuntime.prompts.length, prompts, kind);
    assert.deepEqual(h.owner.list(h.parentId), summaryBefore, kind);
    activeGate?.resolve();
    await activeTurn;
  }
});

test('provider conflict preserves both exact child memberships', () => {
  const first = childRecord('first', 'provider-first', 'tool-first');
  const second = childRecord('second', 'provider-second', 'tool-second');
  const h = createHarness([first, second]);
  const before = h.owner.list(h.parentId);
  h.calls.length = 0;

  const identity = h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider-second',
    role: 'validator',
    spawnLink: { kind: 'tool-use', id: 'tool-first' },
  });

  assert.equal(identity, undefined);
  assert.deepEqual(h.owner.list(h.parentId), before);
  assert.equal(mutationCount(h), 0);
});

test('completion requires provider and spawn to resolve the same exact child', () => {
  const first = childRecord('first', 'provider-first', 'tool-first');
  const second = childRecord('second', 'provider-second', 'tool-second');
  const h = createHarness([first, second]);

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider-first',
    role: 'worker',
    spawnLink: second.spawnLink,
    done: true,
  });
  assert.deepEqual(
    h.owner.list(h.parentId).map((child) => child.status),
    ['paused', 'paused'],
  );

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider-first',
    role: 'worker',
    spawnLink: first.spawnLink,
    done: true,
  });
  assert.deepEqual(
    h.owner.list(h.parentId).map((child) => child.status),
    ['completed', 'paused'],
  );
});

test('result-only completion admits the exact pending spawn as historical', () => {
  const h = createHarness([]);
  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    role: 'worker',
    spawnLink: { kind: 'tool-use', id: 'tool-current' },
    label: 'worker',
    prompt: 'Reply exactly CHILD_SMOKE_OK and stop.',
  });

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider-child-current',
    role: 'worker',
    spawnLink: { kind: 'tool-use', id: 'tool-current' },
    done: true,
  });

  assert.deepEqual(h.owner.list(h.parentId), [
    {
      parentAppSessionId: h.parentId,
      childSessionId: 'generated-child',
      role: 'worker',
      status: 'completed',
      label: 'worker',
      prompt: 'Reply exactly CHILD_SMOKE_OK and stop.',
      modelId: 'model-default',
      reasoningEffort: ReasoningEffort.Low,
      spawnLink: { kind: 'tool-use', id: 'tool-current' },
      transcriptAvailable: true,
      startedAt: 100,
    },
  ]);
  assert.equal(h.history.childSessions(h.parentId)[0]?.providerSessionId, 'provider-child-current');
});

test('completed child under a live parent opens only as history', async () => {
  const record = { ...childRecord('child', 'provider'), status: 'completed' as const };
  const h = createHarness([record]);

  await h.owner.open({
    type: 'child.open',
    parentAppSessionId: h.parentId,
    childSessionId: record.childSessionId,
    requestId: 'history-open',
  });
  await h.owner.send(record, 'must not resurrect');

  assert.equal(
    h.calls.some((call) => call.target === 'runtime' && call.method === 'loadSession'),
    false,
  );
  assert.equal(h.owner.list(h.parentId)[0]?.status, 'completed');
  assert.equal(
    h.events.some(
      (event) =>
        event.type === 'child.updated' &&
        event.requestId === 'history-open' &&
        event.access === 'history',
    ),
    true,
  );
});

test('post-install open failure closes the runtime and reports the exact request', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record], { failReplayChild: true });
  const failedRuntime = await h.open(record);

  assert.equal(h.owner.compactionRetuneTargets().length, 0);
  assert.equal(
    h.calls.filter(
      (call) =>
        call.target === 'cleanup' &&
        call.method === 'session.close' &&
        call.args[0] === record.providerSessionId,
    ).length,
    1,
  );
  assert.equal(
    h.events.some(
      (event) =>
        event.type === 'child.error' &&
        event.operation === 'open' &&
        event.requestId === 'open-child' &&
        event.code === 'child.open_failed' &&
        event.message === 'replay failed',
    ),
    true,
  );
  assert.equal(
    h.events.some(
      (event) =>
        event.type === 'child.updated' &&
        event.requestId === 'open-child' &&
        event.access === 'ready',
    ),
    false,
  );

  const replacement = new FakeFactorySession(record.providerSessionId!, {}, h.calls);
  await h.open(record, replacement);

  assert.notEqual(replacement, failedRuntime);
  assert.equal(h.target(record.childSessionId).providerSessionId, record.providerSessionId);
  assert.equal(
    h.events.some(
      (event) =>
        event.type === 'child.updated' &&
        event.requestId === 'open-child' &&
        event.access === 'ready',
    ),
    true,
  );
});

test('completion during a live stream rejects queued resurrection', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const runtime = await h.open(record);
  const gate = runtime.deferNextStream();
  const active = h.owner.send(record, 'active turn');
  await runtime.waitForPrompts(1);
  await h.owner.send(record, 'queued before completion');

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider',
    role: 'worker',
    done: true,
  });
  gate.resolve();
  await active;

  assert.deepEqual(runtime.prompts, ['active turn']);
  assert.equal(h.owner.list(h.parentId)[0]?.status, 'completed');
  assert.equal(
    h.calls.some(
      (call) =>
        call.target === 'cleanup' &&
        call.method === 'session.close' &&
        call.args[0] === record.providerSessionId,
    ),
    true,
  );
});

test('completion during automatic compaction discards queued resurrection', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const captured = await queueForAutomaticSettlement(h, record.childSessionId);

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: record.providerSessionId,
    role: 'worker',
    done: true,
  });
  h.owner.settleAutomatic(captured.settlement);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(captured.runtime.prompts, []);
  assert.equal(h.owner.list(h.parentId)[0]?.status, 'completed');
  assert.equal(
    h.calls.some((call) => call.target === 'cleanup' && call.method === 'session.close'),
    true,
  );
});

test('turn setup failures settle cleanly and permit the next send', async () => {
  for (const failDriveSetup of ['beginTurn', 'commit', 'startPolling'] as const) {
    const record = childRecord('child', 'provider');
    const h = createHarness([record], { failDriveSetup });
    const runtime = await h.open(record);

    await h.owner.send(record, `fail during ${failDriveSetup}`);

    assert.deepEqual(runtime.prompts, [], failDriveSetup);
    assert.equal(h.owner.list(h.parentId)[0]?.status, 'paused', failDriveSetup);
    assert.equal(
      h.calls.some((call) => call.target === 'cleanup' && call.method === 'context.stopPolling'),
      true,
      failDriveSetup,
    );
    assert.equal(
      h.events.some(
        (event) =>
          event.type === 'child.error' &&
          event.operation === 'send' &&
          event.message === `${failDriveSetup} failed`,
      ),
      true,
      failDriveSetup,
    );

    await h.owner.send(record, `recover after ${failDriveSetup}`);
    assert.deepEqual(runtime.prompts, [`recover after ${failDriveSetup}`], failDriveSetup);
    assert.equal(h.owner.list(h.parentId)[0]?.status, 'paused', failDriveSetup);
  }
});

test('completion invalidates a role observation queued behind settings', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const runtime = await h.open(record);
  h.events.length = 0;
  const gate = runtime.deferNextUpdateSettings();
  const update = h.owner.updateSettings({
    type: 'child.updateSettings',
    parentAppSessionId: h.parentId,
    childSessionId: record.childSessionId,
    modelId: 'stale-model',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: record.providerSessionId,
    role: 'validator',
    ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
  });

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider',
    role: 'worker',
    done: true,
  });
  gate.resolve();
  await update;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(h.owner.list(h.parentId)[0]?.status, 'completed');
  assert.equal(h.owner.list(h.parentId)[0]?.role, 'worker');
  assert.equal(
    h.events.some((event) => event.type === 'session.child' && event.child.role === 'validator'),
    false,
  );
});

test('completion rejects an immediate stale provider observation', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  await h.open(record);
  h.events.length = 0;

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider',
    role: 'worker',
    done: true,
  });
  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: record.providerSessionId,
    role: 'validator',
    ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(h.owner.list(h.parentId)[0]?.status, 'completed');
  assert.equal(h.owner.list(h.parentId)[0]?.role, 'worker');
  assert.equal(
    h.events.some((event) => event.type === 'session.child' && event.child.status === 'running'),
    false,
  );
});

test('repeated same-provider observation preserves automatic compaction settlement', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const runtime = await h.open(record);
  const target = h.target(record.childSessionId);
  const captured = settlement(target);
  target.setAutoCompacting(true);
  await h.owner.send(record, 'queued after compaction');

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: record.providerSessionId,
    role: record.role,
    ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
  });
  h.owner.settleAutomatic(captured);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(runtime.prompts, ['queued after compaction']);
});

test('repeated child observations publish only new task prompts', () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const observe = (prompt?: string) =>
    h.owner.admitChildObservation({
      parentAppSessionId: h.parentId,
      providerSessionId: record.providerSessionId,
      role: record.role,
      ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
      ...(prompt ? { prompt } : {}),
    });

  observe('first prompt');
  observe();
  observe('first prompt');
  observe('changed prompt');

  assert.deepEqual(
    h.calls
      .filter((call) => call.target === 'protocol' && call.method === 'timeline.status')
      .map((call) => call.args[1]),
    ['Task prompt\n\nfirst prompt', 'Task prompt\n\nchanged prompt'],
  );
});

test('repeated same-provider observation preserves in-flight settings settlement', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const runtime = await h.open(record);
  const gate = runtime.deferNextUpdateSettings();
  const update = h.owner.updateSettings({
    type: 'child.updateSettings',
    parentAppSessionId: h.parentId,
    childSessionId: record.childSessionId,
    modelId: 'accepted-model',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: record.providerSessionId,
    role: record.role,
    ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
  });
  gate.resolve();
  await update;

  assert.equal(h.owner.list(h.parentId)[0]?.modelId, 'accepted-model');
});

test('changed role is serialized after accepted in-flight settings', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const runtime = await h.open(record);
  h.events.length = 0;
  const gate = runtime.deferNextUpdateSettings();
  const update = h.owner.updateSettings({
    type: 'child.updateSettings',
    parentAppSessionId: h.parentId,
    childSessionId: record.childSessionId,
    modelId: 'accepted-model',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: record.providerSessionId,
    role: 'validator',
    ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
  });
  assert.equal(h.owner.list(h.parentId)[0]?.role, 'worker');
  assert.equal(
    h.events.some((event) => event.type === 'session.child' && event.child.role === 'validator'),
    false,
  );

  gate.resolve();
  await update;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const published = h.events
    .filter((event) => event.type === 'session.child')
    .map((event) => [event.child.role, event.child.modelId]);
  assert.deepEqual(published, [
    ['worker', 'accepted-model'],
    ['validator', 'accepted-model'],
  ]);
  assert.equal(h.owner.list(h.parentId)[0]?.role, 'validator');
  assert.equal(
    h.calls.some((call) => call.target === 'cleanup' && call.method === 'session.close'),
    false,
  );
});

test('changed role cancels and invalidates its captured automatic target', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  await h.open(record);
  const target = h.target(record.childSessionId);
  const captured = settlement(target);
  target.setAutoCompacting(true);

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: record.providerSessionId,
    role: 'validator',
    ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.owner.settleAutomatic(captured);

  assert.equal(target.isCurrent(), false);
  assert.equal(target.isAutoCompacting(), false);
  assert.equal(h.target(record.childSessionId).isAutoCompacting(), false);
  assert.equal(
    h.calls.some((call) => call.target === 'cleanup' && call.method === 'session.close'),
    false,
  );
});

test('stale automatic callbacks cannot mutate newer turn or configuration state', async () => {
  for (const kind of ['turn', 'configuration'] as const) {
    const record = childRecord('child', 'provider');
    const h = createHarness([record]);
    const runtime = await h.open(record);
    const stale = h.target(record.childSessionId);
    let turn: Promise<void> | undefined;
    let gate: StreamGate | undefined;
    if (kind === 'turn') {
      gate = runtime.deferNextStream();
      turn = h.owner.send(record, 'advance turn');
      await runtime.waitForPrompts(1);
    } else {
      await h.owner.updateSettings({
        type: 'child.updateSettings',
        parentAppSessionId: h.parentId,
        childSessionId: record.childSessionId,
        modelId: 'model-new',
      });
    }

    stale.setAutoCompacting(true);
    assert.equal(stale.isAutoCompacting(), false, kind);
    assert.equal(stale.isStreaming(), false, kind);
    assert.equal(h.target(record.childSessionId).isAutoCompacting(), false, kind);
    gate?.resolve();
    await turn;
  }
});

test('queued settings admitted to an old runtime cannot cross provider replacement', async () => {
  const record = childRecord('child', 'provider-old');
  const h = createHarness([record]);
  const original = await h.open(record);
  const firstGate = original.deferNextUpdateSettings();
  const first = h.owner.updateSettings({
    type: 'child.updateSettings',
    parentAppSessionId: h.parentId,
    childSessionId: record.childSessionId,
    modelId: 'stale-first',
  });
  await original.waitForSettings(1);
  const second = h.owner.updateSettings({
    type: 'child.updateSettings',
    parentAppSessionId: h.parentId,
    childSessionId: record.childSessionId,
    modelId: 'stale-second',
  });

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider-new',
    role: 'worker',
    spawnLink: { kind: 'tool-use', id: `tool-${record.childSessionId}` },
  });
  const replacementRecord = { ...record, providerSessionId: 'provider-new' };
  const replacementSession = new FakeFactorySession('provider-new', {}, h.calls);
  const replacing = h.open(replacementRecord, replacementSession);
  await Promise.resolve();

  assert.equal(
    h.calls.some(
      (call) =>
        call.target === 'cleanup' &&
        call.method === 'session.close' &&
        call.args[0] === 'provider-old',
    ),
    false,
  );
  assert.equal(replacementSession.settings.length, 0);

  firstGate.resolve();
  await Promise.all([first, second, replacing]);

  assert.deepEqual(
    original.settings.map((settings) => settings.modelId),
    ['stale-first'],
  );
  assert.deepEqual(replacementSession.settings, []);
  assert.ok(
    h.calls.findIndex((call) => call.target === 'provider' && call.method === 'updateSettings') <
      h.calls.findIndex((call) => call.target === 'cleanup' && call.method === 'session.close'),
  );
  assert.equal(h.owner.list(h.parentId)[0]?.modelId, 'model-default');
});

test('rapid provider replacements retire every intermediate identity', async () => {
  const record = childRecord('child', 'provider-a');
  const h = createHarness([record]);
  const original = await h.open(record);
  const settingsGate = original.deferNextUpdateSettings();
  const update = h.owner.updateSettings({
    type: 'child.updateSettings',
    parentAppSessionId: h.parentId,
    childSessionId: record.childSessionId,
    modelId: 'accepted-before-replacement',
  });
  await original.waitForSettings(1);

  for (const providerSessionId of ['provider-b', 'provider-c'])
    h.owner.admitChildObservation({
      parentAppSessionId: h.parentId,
      providerSessionId,
      role: 'worker',
      ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
    });
  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider-b',
    role: 'validator',
    ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
  });
  settingsGate.resolve();
  await update;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(
    h.history.childSession(h.parentId, record.childSessionId)?.providerSessionId,
    'provider-c',
  );
  assert.equal(h.owner.list(h.parentId)[0]?.role, 'worker');
  const replacement = { ...record, providerSessionId: 'provider-c' };
  await h.open(replacement, new FakeFactorySession('provider-c', {}, h.calls));
  const before = mutationCount(h);
  const observed = h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider-b',
    role: 'validator',
    ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
  });

  assert.equal(observed, undefined);
  assert.equal(mutationCount(h), before);
  assert.equal(h.target(record.childSessionId).providerSessionId, 'provider-c');
});

test('runtime close invalidates immediately and waits for in-flight settings teardown', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const runtime = await h.open(record);
  const settingsGate = runtime.deferNextUpdateSettings();
  const update = h.owner.updateSettings({
    type: 'child.updateSettings',
    parentAppSessionId: h.parentId,
    childSessionId: record.childSessionId,
    modelId: 'stale-model',
  });
  await runtime.waitForSettings(1);

  const closing = h.owner.close(record);
  await Promise.resolve();
  assert.equal(h.owner.compactionRetuneTargets().length, 0);
  assert.equal(
    h.calls.some((call) => call.target === 'cleanup' && call.method === 'context.forgetChild'),
    true,
  );
  assert.equal(
    h.calls.some((call) => call.target === 'cleanup' && call.method === 'context.stopPolling'),
    true,
  );
  assert.equal(
    h.calls.some((call) => call.target === 'cleanup' && call.method === 'session.close'),
    false,
  );

  settingsGate.resolve();
  await Promise.all([update, closing]);
  await h.owner.close(record);

  assert.equal(
    h.calls.filter((call) => call.target === 'cleanup' && call.method === 'session.close').length,
    1,
  );
  assert.equal(h.owner.list(h.parentId)[0]?.modelId, 'model-default');
});

test('retired provider-only observations cannot create or complete a ghost child', async () => {
  const record = childRecord('child', 'provider-old');
  const h = createHarness([record]);
  await h.open(record);
  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider-new',
    role: 'worker',
    ...(record.spawnLink ? { spawnLink: record.spawnLink } : {}),
  });
  const replacement = { ...record, providerSessionId: 'provider-new' };
  await h.open(replacement, new FakeFactorySession('provider-new', {}, h.calls));
  h.events.length = 0;
  h.calls.length = 0;
  const before = h.owner.list(h.parentId);

  const observed = h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider-old',
    role: 'worker',
  });
  const completed = h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider-old',
    role: 'worker',
    done: true,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(observed, undefined);
  assert.equal(completed, undefined);
  assert.deepEqual(h.owner.list(h.parentId), before);
  assert.equal(mutationCount(h), 0);
});

test('capacity eviction blocks victim reopen until old provider close settles', async () => {
  const first = childRecord('first', 'provider-first');
  const second = childRecord('second', 'provider-second');
  const h = createHarness([first, second], { maxOpenSessions: 1 });
  const firstRuntime = await h.open(first);
  const closeGate = firstRuntime.deferNextClose();
  h.runtime.loadQueue.set('provider-second', [
    new FakeFactorySession('provider-second', {}, h.calls),
  ]);
  h.runtime.loadQueue.set('provider-first', [
    new FakeFactorySession('provider-first', {}, h.calls),
  ]);

  const openingSecond = h.owner.open({
    type: 'child.open',
    parentAppSessionId: h.parentId,
    childSessionId: second.childSessionId,
    requestId: 'open-second',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const reopeningFirst = h.owner.open({
    type: 'child.open',
    parentAppSessionId: h.parentId,
    childSessionId: first.childSessionId,
    requestId: 'reopen-first',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    h.calls
      .filter((call) => call.target === 'runtime' && call.method === 'loadSession')
      .map((call) => call.args[0]),
    ['provider-first'],
  );

  closeGate.resolve();
  await Promise.all([openingSecond, reopeningFirst]);
  const oldClose = h.calls.findIndex(
    (call) =>
      call.target === 'cleanup' &&
      call.method === 'session.close' &&
      call.args[0] === 'provider-first',
  );
  const laterLoad = h.calls.findIndex(
    (call, index) => index > oldClose && call.target === 'runtime' && call.method === 'loadSession',
  );
  assert.ok(oldClose >= 0);
  assert.ok(laterLoad > oldClose);
});

test('late notification after child close cannot publish, mutate, or rearm compaction', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const runtime = await h.open(record);
  const automatic = h.target(record.childSessionId);
  automatic.setAutoCompacting(true);
  const deliverLate = runtime.captureNotification({
    type: 'droid_working_state_changed',
    newState: 'streaming',
  });
  const closeGate = runtime.deferNextClose();
  const closing = h.owner.close(record);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const callsBefore = h.calls.length;
  const eventsBefore = h.events.length;
  const summaryBefore = h.owner.list(h.parentId);
  assert.doesNotThrow(deliverLate);
  assert.equal(h.calls.length, callsBefore);
  assert.equal(h.events.length, eventsBefore);
  assert.deepEqual(h.owner.list(h.parentId), summaryBefore);
  assert.equal(automatic.isAutoCompacting(), false);

  closeGate.resolve();
  await closing;
});

test('interrupt waits for the active iterator before starting the next child turn', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const runtime = await h.open(record);
  const firstGate = runtime.deferNextStream();
  const first = h.owner.send(record, 'first');
  await runtime.waitForPrompts(1);

  await h.owner.interrupt(record);
  await h.owner.send(record, 'second');
  assert.deepEqual(runtime.prompts, ['first']);

  firstGate.resolve();
  await first;
  await runtime.waitForPrompts(2);
  assert.deepEqual(runtime.prompts, ['first', 'second']);
});

test('interrupt rejection publishes an exact child error without failing the parent command', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const runtime = await h.open(record);
  h.events.length = 0;
  const gate = runtime.deferNextInterrupt();
  const interrupting = h.owner.interrupt(record);
  gate.reject(new Error('provider interrupt rejected'));

  await assert.doesNotReject(interrupting);
  assert.equal(
    h.events.some(
      (event) =>
        event.type === 'child.error' &&
        event.parentAppSessionId === record.parentAppSessionId &&
        event.childSessionId === record.childSessionId &&
        event.operation === 'interrupt' &&
        event.code === 'child.interrupt_failed' &&
        event.message === 'provider interrupt rejected',
    ),
    true,
  );
});

test('stale interrupt and turn settlement cannot make a replacement turn idle', async () => {
  for (const kind of ['interrupt', 'settlement'] as const) {
    const record = childRecord('child', 'provider-old');
    const h = createHarness([record]);
    const oldRuntime = await h.open(record);
    let stale: Promise<void>;
    let releaseStale: StreamGate;
    if (kind === 'interrupt') {
      releaseStale = oldRuntime.deferNextInterrupt();
      stale = h.owner.interrupt(record);
    } else {
      releaseStale = oldRuntime.deferNextStream();
      stale = h.owner.send(record, 'old turn');
      await oldRuntime.waitForPrompts(1);
    }

    h.owner.admitChildObservation({
      parentAppSessionId: h.parentId,
      providerSessionId: 'provider-new',
      role: 'worker',
      spawnLink: { kind: 'tool-use', id: `tool-${record.childSessionId}` },
    });
    const replacementRecord = { ...record, providerSessionId: 'provider-new' };
    const replacement = await h.open(
      replacementRecord,
      new FakeFactorySession('provider-new', {}, h.calls),
    );
    const activeGate = replacement.deferNextStream();
    const active = h.owner.send(record, 'replacement turn');
    await replacement.waitForPrompts(1);

    releaseStale.resolve();
    await stale;
    await h.owner.send(record, 'must queue');
    assert.deepEqual(replacement.prompts, ['replacement turn'], kind);

    activeGate.resolve();
    await active;
  }
});

test('stale send-now rejection cannot clear replacement steering state', async () => {
  const record = childRecord('child', 'provider-old');
  const h = createHarness([record]);
  const oldRuntime = await h.open(record);
  const oldStreamGate = oldRuntime.deferNextStream();
  const oldTurn = h.owner.send(record, 'old turn');
  await oldRuntime.waitForPrompts(1);
  const oldInterruptGate = oldRuntime.deferNextInterrupt();
  const oldSteer = h.owner.sendNow(record, 'old steer');
  await new Promise<void>((resolve) => setImmediate(resolve));

  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: 'provider-new',
    role: 'worker',
    spawnLink: { kind: 'tool-use', id: `tool-${record.childSessionId}` },
  });
  const replacementRecord = { ...record, providerSessionId: 'provider-new' };
  const replacement = await h.open(
    replacementRecord,
    new FakeFactorySession('provider-new', {}, h.calls),
  );
  const replacementStreamGate = replacement.deferNextStream();
  replacement.nextStreamError = new Error('replacement turn failed');
  const replacementTurn = h.owner.send(record, 'replacement turn');
  await replacement.waitForPrompts(1);
  const replacementInterruptGate = replacement.deferNextInterrupt();
  const replacementSteer = h.owner.sendNow(record, 'replacement steer');
  await new Promise<void>((resolve) => setImmediate(resolve));

  oldInterruptGate.reject(new Error('old interrupt failed'));
  await oldSteer;
  replacementStreamGate.resolve();
  await replacementTurn;

  assert.equal(
    h.events.some((event) => event.type === 'child.error' && event.code === 'child.send_failed'),
    false,
  );
  assert.equal(
    h.calls.some(
      (call) =>
        call.method === 'timeline.status' &&
        call.args.includes('Child-session turn interrupted for steering.'),
    ),
    true,
  );

  replacementInterruptGate.resolve();
  await replacementSteer;
  oldStreamGate.resolve();
  await oldTurn;
});

test('one child cleanup failure cannot block sibling provider close', async () => {
  const first = childRecord('first', 'provider-first');
  const second = childRecord('second', 'provider-second');
  const h = createHarness([first, second], { failForgetChild: 'first' });
  await h.open(first);
  await h.open(second);
  h.calls.length = 0;

  await h.owner.closeParent(h.parentId);

  assert.deepEqual(
    h.calls
      .filter((call) => call.target === 'cleanup' && call.method === 'session.close')
      .map((call) => call.args[0])
      .sort(),
    ['provider-first', 'provider-second'],
  );
});
