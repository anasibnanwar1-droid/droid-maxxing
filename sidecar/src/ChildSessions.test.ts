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
  options: { maxOpenSessions?: number; failForgetChild?: string } = {},
): Harness {
  const calls: RecordedCall[] = [];
  const events: ServerEvent[] = [];
  const history = new FakeHistoryIndex(calls);
  const runtime = new FakeFactoryRuntime(calls);
  const parentId = 'parent';
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
        calls.push({ target: 'protocol', method: 'timeline.replayChild', args });
      },
    },
    eventFlow: {
      beginTurn: (...args) => {
        calls.push({ target: 'protocol', method: 'turn.begin', args });
      },
      applyNotification: () => undefined,
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
      startPolling: () => undefined,
      stopPolling: () => undefined,
    },
    compaction: {
      afterTurn: () => undefined,
      arm: () => Promise.resolve(true),
      cancel: (target) => {
        if (target.kind === 'child') target.setAutoCompacting(false);
      },
      handleChildNotification: () => false,
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
        toolUseId: `tool-${record.childSessionId}`,
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
    toolUseId: 'tool-first',
  });

  assert.deepEqual(identity, {
    parentAppSessionId: h.parentId,
    childSessionId: 'first',
  });
  assert.deepEqual(h.owner.list(h.parentId), before);
  assert.equal(mutationCount(h), 0);
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

test('completion during a live stream rejects queued resurrection', async () => {
  const record = childRecord('child', 'provider');
  const h = createHarness([record]);
  const runtime = await h.open(record);
  const gate = runtime.deferNextStream();
  const active = h.owner.send(record, 'active turn');
  await runtime.waitForPrompts(1);

  h.owner.completeByProviderObservation(h.parentId, 'provider');
  await h.owner.send(record, 'must not queue');
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
    toolUseId: record.spawnLink?.id,
  });

  h.owner.completeByProviderObservation(h.parentId, 'provider');
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

  h.owner.completeByProviderObservation(h.parentId, 'provider');
  h.owner.admitChildObservation({
    parentAppSessionId: h.parentId,
    providerSessionId: record.providerSessionId,
    role: 'validator',
    toolUseId: record.spawnLink?.id,
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
    toolUseId: record.spawnLink?.id,
  });
  h.owner.settleAutomatic(captured);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(runtime.prompts, ['queued after compaction']);
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
    toolUseId: record.spawnLink?.id,
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
    toolUseId: record.spawnLink?.id,
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
    toolUseId: record.spawnLink?.id,
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
  await new Promise<void>((resolve) => setImmediate(resolve));
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
    toolUseId: `tool-${record.childSessionId}`,
  });
  const replacementRecord = { ...record, providerSessionId: 'provider-new' };
  const replacement = await h.open(
    replacementRecord,
    new FakeFactorySession('provider-new', {}, h.calls),
  );

  firstGate.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(
    original.settings.map((settings) => settings.modelId),
    ['stale-first'],
  );
  assert.deepEqual(replacement.settings, []);
  assert.equal(h.owner.list(h.parentId)[0]?.modelId, 'model-default');
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
      toolUseId: `tool-${record.childSessionId}`,
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
    toolUseId: `tool-${record.childSessionId}`,
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
