import assert from 'node:assert/strict';
import test from 'node:test';
import { ReasoningEffort } from '@factory/droid-sdk';

import { MissionControlPolicy } from './MissionControlPolicy.js';
import type {
  ChildIdentity,
  ChildParentLease,
  ChildSpawnObservation,
} from './ChildSessionState.js';
import type { NormalizedSideEffects } from './SessionEventFlow.js';
import type { ServerEvent, SessionSummary } from './protocol.js';
import { FakeFactorySession, type RecordedCall } from './testing/fakeFactoryRuntime.js';

interface Harness {
  policy: MissionControlPolicy;
  admissions: ChildSpawnObservation[];
  events: ServerEvent[];
  summary: SessionSummary;
  apply(effects: NormalizedSideEffects): void;
  rejectProvider(providerSessionId: string): void;
}

function createHarness(
  sessionPurpose: SessionSummary['sessionPurpose'] = 'mission-control',
  interactionMode: SessionSummary['interactionMode'] = 'agi',
): Harness {
  const calls: RecordedCall[] = [];
  const events: ServerEvent[] = [];
  const admissions: ChildSpawnObservation[] = [];
  const childrenBySpawn = new Map<string, ChildIdentity>();
  const rejectedProviders = new Set<string>();
  const summary = missionSummary(sessionPurpose, interactionMode);
  const live: ChildParentLease = {
    summary,
    session: new FakeFactorySession('parent-provider', {}, calls, {
      settings: {
        modelId: 'accepted-parent-model',
        reasoningEffort: ReasoningEffort.Medium,
      },
    }),
  };
  const policy = new MissionControlPolicy({
    registry: {
      getLive: (appSessionId) => (appSessionId === summary.appSessionId ? live : undefined),
      updateSummary: (_appSessionId, patch) => {
        Object.assign(summary, patch);
        return summary;
      },
    },
    childSessions: {
      admitChildObservation: (observation) => {
        admissions.push(observation);
        if (observation.done || !observation.spawnLink) return undefined;
        if (observation.providerSessionId && rejectedProviders.has(observation.providerSessionId))
          return undefined;
        const existing = childrenBySpawn.get(observation.spawnLink.id);
        if (existing) return existing;
        const identity = {
          parentAppSessionId: observation.parentAppSessionId,
          childSessionId: `child-${childrenBySpawn.size + 1}`,
        };
        childrenBySpawn.set(observation.spawnLink.id, identity);
        return identity;
      },
    },
    resolveCatalogDefaultSettings: () => ({
      modelId: 'catalog-model',
      reasoningEffort: ReasoningEffort.Low,
    }),
    emit: (event) => events.push(event),
  });
  return {
    policy,
    admissions,
    events,
    summary,
    apply: (effects) => policy.apply(summary.appSessionId, effects),
    rejectProvider: (providerSessionId) => {
      rejectedProviders.add(providerSessionId);
    },
  };
}

test('holds raw Mission workers until exact WorkerStarted spawn correlation', () => {
  const h = createHarness();
  h.apply({
    missionChild: { event: 'started', providerSessionId: 'provider-worker' },
  });
  assert.deepEqual(h.admissions, []);

  h.apply({
    progress: [
      {
        type: 'worker_started',
        timestamp: '2026-07-29T00:00:00.000Z',
        workerProviderSessionId: 'provider-worker',
        spawnId: 'spawn-1',
      },
    ],
  });

  assert.deepEqual(h.admissions, [
    {
      parentAppSessionId: 'parent-app',
      providerSessionId: 'provider-worker',
      role: 'worker',
      spawnLink: { kind: 'spawn', id: 'spawn-1' },
    },
  ]);
  assert.deepEqual(progressEntries(h.events), [
    {
      type: 'worker_started',
      timestamp: '2026-07-29T00:00:00.000Z',
      workerChildSessionId: 'child-1',
    },
  ]);
  assert.equal(JSON.stringify(h.events).includes('provider-worker'), false);
});

test('keeps same-role siblings distinct and projects later progress by exact correlation', () => {
  const h = createHarness();
  h.apply({
    progress: [
      workerStarted('provider-a', 'spawn-a'),
      workerStarted('provider-b', 'spawn-b'),
      {
        type: 'worker_selected_feature',
        timestamp: 'later',
        workerProviderSessionId: 'provider-a',
        featureId: 'feature-a',
      },
    ],
  });

  assert.deepEqual(
    h.admissions.map((observation) => observation.spawnLink?.id),
    ['spawn-a', 'spawn-b'],
  );
  assert.deepEqual(
    progressEntries(h.events).map((entry) => entry.workerChildSessionId),
    ['child-1', 'child-2', 'child-1'],
  );
});

test('settles completion received before exact spawn correlation', () => {
  const h = createHarness();
  h.apply({
    missionChild: { event: 'completed', providerSessionId: 'provider-worker' },
  });
  assert.deepEqual(h.admissions, []);
  h.apply({ progress: [workerStarted('provider-worker', 'spawn-1')] });

  assert.deepEqual(h.admissions, [
    {
      parentAppSessionId: 'parent-app',
      providerSessionId: 'provider-worker',
      role: 'worker',
      spawnLink: { kind: 'spawn', id: 'spawn-1' },
    },
    {
      parentAppSessionId: 'parent-app',
      providerSessionId: 'provider-worker',
      role: 'worker',
      spawnLink: { kind: 'spawn', id: 'spawn-1' },
      done: true,
    },
  ]);
});

test('provider replacement preserves child identity and rejects stale provider completion', () => {
  const h = createHarness();
  h.apply({ progress: [workerStarted('provider-old', 'spawn-1')] });
  h.apply({ progress: [workerStarted('provider-new', 'spawn-1')] });
  h.apply({ progress: [workerStarted('provider-old', 'spawn-1')] });
  h.apply({
    progress: [
      {
        type: 'worker_failed',
        timestamp: 'stale',
        workerProviderSessionId: 'provider-old',
        spawnId: 'spawn-1',
      },
    ],
  });
  h.apply({
    missionChild: { event: 'completed', providerSessionId: 'provider-old' },
  });
  h.apply({
    missionChild: { event: 'completed', providerSessionId: 'provider-new' },
  });

  assert.deepEqual(
    progressEntries(h.events).map((entry) => entry.workerChildSessionId),
    ['child-1', 'child-1', undefined, undefined],
  );
  assert.equal(h.admissions.filter((observation) => observation.done).length, 1);
  assert.equal(h.admissions.at(-1)?.providerSessionId, 'provider-new');
});

test('rejects one provider being rebound to a different spawn', () => {
  const h = createHarness();
  h.apply({ progress: [workerStarted('provider-shared', 'spawn-1')] });
  h.apply({ progress: [workerStarted('provider-shared', 'spawn-2')] });

  assert.deepEqual(
    progressEntries(h.events).map((entry) => entry.workerChildSessionId),
    ['child-1', undefined],
  );
  assert.equal(h.admissions.length, 1);
});

test('does not project a provider and spawn rejected by the generic owner', () => {
  const h = createHarness();
  h.rejectProvider('provider-conflict');
  h.apply({ progress: [workerStarted('provider-conflict', 'spawn-conflict')] });

  assert.equal(progressEntries(h.events)[0]?.workerChildSessionId, undefined);
});

test('never infers a validator child from validation progress', () => {
  const h = createHarness();
  h.apply({
    progress: [
      {
        type: 'milestone_validation_triggered',
        timestamp: 'now',
        featureId: 'feature-validation',
      },
    ],
  });

  assert.deepEqual(h.admissions, []);
  assert.equal(progressEntries(h.events)[0]?.workerChildSessionId, undefined);
});

test('ignores Mission effects for ordinary auto, spec, and agi chat sessions', () => {
  for (const interactionMode of ['auto', 'spec', 'agi'] as const) {
    const h = createHarness('chat', interactionMode);
    h.apply({
      missionChild: { event: 'started', providerSessionId: 'provider-worker' },
      progress: [workerStarted('provider-worker', 'spawn-1')],
      missionState: 'running',
      features: [],
    });
    assert.deepEqual(h.admissions, []);
    assert.deepEqual(h.events, []);
  }
});

test('owns Mission defaults, features, phase, and teardown-only correlation state', () => {
  const h = createHarness();
  h.summary.workerModelId = 'worker-model';
  h.summary.workerReasoningEffort = ReasoningEffort.High;
  assert.deepEqual(h.policy.resolveDefaultSettings('parent-app', 'worker'), {
    modelId: 'worker-model',
    reasoningEffort: ReasoningEffort.High,
  });
  assert.deepEqual(h.policy.resolveDefaultSettings('parent-app', 'validator'), {
    modelId: 'accepted-parent-model',
    reasoningEffort: ReasoningEffort.Medium,
  });

  h.apply({
    features: [],
    missionState: 'completed',
    missionChild: { event: 'started', providerSessionId: 'provider-stale' },
  });
  assert.equal(h.summary.phase, 'completed');
  assert.equal(h.events[0]?.type, 'mission.features');

  h.policy.forget('parent-app');
  h.apply({ progress: [workerStarted('provider-stale', 'spawn-fresh')] });
  assert.equal(h.admissions.length, 1);
  assert.equal(h.admissions[0]?.done, undefined);
  h.policy.clear();
});

function workerStarted(
  workerProviderSessionId: string,
  spawnId: string,
): NonNullable<NormalizedSideEffects['progress']>[number] {
  return {
    type: 'worker_started',
    timestamp: `${spawnId}-time`,
    workerProviderSessionId,
    spawnId,
  };
}

function progressEntries(events: ServerEvent[]) {
  return events
    .filter((event) => event.type === 'mission.progress')
    .flatMap((event) => event.entries);
}

function missionSummary(
  sessionPurpose: SessionSummary['sessionPurpose'],
  interactionMode: SessionSummary['interactionMode'],
): SessionSummary {
  return {
    appSessionId: 'parent-app',
    providerSessionId: 'parent-provider',
    missionId: 'mission-1',
    sessionPurpose,
    interactionMode,
    role: 'primary',
    title: 'Mission',
    goal: 'Ship',
    cwd: '',
    workspaceKind: 'none',
    autonomy: 'medium',
    phase: 'running',
    compacting: false,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}
