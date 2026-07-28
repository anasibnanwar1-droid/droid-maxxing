import assert from 'node:assert/strict';
import test from 'node:test';

import type { FactoryDefaultSettings, SessionSummary } from './protocol.js';
import {
  childCompactionModelId,
  SessionCompaction,
  type ChildCompactionTarget,
  type PrimaryCompactionTarget,
  type SessionCompactionDependencies,
} from './SessionCompaction.js';
import type { LiveChildSession } from './SessionLifecycle.js';
import {
  FakeFactorySession,
  type RecordedCall,
  type StreamGate,
} from './testing/fakeFactoryRuntime.js';

interface Harness {
  calls: RecordedCall[];
  compaction: SessionCompaction;
  patches: { appSessionId: string; patch: Partial<SessionSummary> }[];
  setDefaultsReader(reader: () => Promise<FactoryDefaultSettings>): void;
}

function createHarness(): Harness {
  const calls: RecordedCall[] = [];
  const patches: Harness['patches'] = [];
  let readDefaults = (): Promise<FactoryDefaultSettings> =>
    Promise.resolve({
      modelId: 'default-model',
      compactionTokenLimit: 900,
      compactionTokenLimitPerModel: { 'default-model': 700 },
    });
  const registry: SessionCompactionDependencies['registry'] = {
    updateSummary: (appSessionId, patch) => {
      patches.push({ appSessionId, patch });
      return undefined;
    },
  };
  const compaction = new SessionCompaction({
    registry,
    getFactoryDefaults: () => readDefaults(),
    maxContextTokensForModel: (modelId) => (modelId === 'unbounded' ? undefined : 1_000),
  });
  return {
    calls,
    compaction,
    patches,
    setDefaultsReader: (reader) => {
      readDefaults = reader;
    },
  };
}

function primaryTarget(
  h: Harness,
  id = 'app-1',
  configuredModelId: string | undefined = 'model-a',
): {
  session: FakeFactorySession;
  target: PrimaryCompactionTarget;
  setCurrent(value: boolean): void;
} {
  const session = new FakeFactorySession(`${id}-backend`, {}, h.calls);
  let current = true;
  const target: PrimaryCompactionTarget = {
    kind: 'primary',
    appSessionId: id,
    providerSessionId: session.sessionId,
    sourceSessionId: id,
    session,
    configuredModelId,
    defaultsMode: 'auto',
    isCurrent: () => current,
  };
  return { session, target, setCurrent: (value) => (current = value) };
}

function childTarget(
  h: Harness,
  effectiveModelId: string,
): {
  session: FakeFactorySession;
  target: ChildCompactionTarget;
  setCurrent(value: boolean): void;
  setModel(value: string): void;
} {
  const session = new FakeFactorySession('child-backend', {}, h.calls);
  const child: LiveChildSession = {
    session,
    childSessionId: 'child-logical',
    appSessionId: 'app-1',
    role: 'worker',
    lastUsedAt: 1,
    streaming: false,
    autoCompacting: false,
    pendingSends: [],
  };
  let current = true;
  let modelId = effectiveModelId;
  const target: ChildCompactionTarget = {
    kind: 'child',
    appSessionId: 'app-1',
    parentAppSessionId: 'app-1',
    childSessionId: child.childSessionId,
    providerSessionId: session.sessionId,
    sourceSessionId: session.sessionId,
    session,
    role: child.role,
    child,
    effectiveModelId,
    isCurrent: () => current && modelId === effectiveModelId && child.session === session,
  };
  return {
    session,
    target,
    setCurrent: (value) => (current = value),
    setModel: (value) => (modelId = value),
  };
}

function settingsLimit(session: FakeFactorySession): number | undefined {
  const value = session.settings.at(-1)?.['compactionTokenLimit'];
  return typeof value === 'number' ? value : undefined;
}

function deferredDefaults(): {
  promise: Promise<FactoryDefaultSettings>;
  resolve(): void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<FactoryDefaultSettings>((done) => {
    resolve = () => done({ compactionTokenLimit: 900 });
  });
  return { promise, resolve };
}

test('limit resolution preserves UI, exposed, default, override, and window precedence', async () => {
  const h = createHarness();
  await h.compaction.updateLimits(
    { compactionTokenLimit: 600, compactionTokenLimitPerModel: { 'model-a': 400 } },
    [],
  );
  assert.equal(await h.compaction.resolveLimit({ modelId: 'model-a' }), 400);
  assert.equal(await h.compaction.resolveLimit({ modelId: 'model-b' }), 600);
  assert.equal(
    await h.compaction.resolveLimit({
      modelId: 'model-a',
      uiOverride: { compactionTokenLimit: 500 },
    }),
    400,
  );

  await h.compaction.updateLimits({}, []);
  assert.equal(
    await h.compaction.resolveLimit({
      modelId: 'model-a',
      exposed: { compactionTokenLimit: 650.9 },
    }),
    650,
  );
  await h.compaction.updateLimits(
    { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
    [],
  );
  assert.equal(await h.compaction.resolveLimit({ modelId: 'model-a' }), 800);
  const summary = {
    modelId: 'parent-model',
    workerModelId: 'worker-model',
    validatorModelId: 'validator-model',
  };
  assert.equal(
    childCompactionModelId(summary, { modelId: 'loaded-model' }, 'worker'),
    'loaded-model',
  );
  assert.equal(childCompactionModelId(summary, undefined, 'worker'), 'worker-model');
  assert.equal(childCompactionModelId(summary, undefined, 'validator'), 'validator-model');
});

test('arm writes only while its exact provisional target remains current', async () => {
  const h = createHarness();
  const live = primaryTarget(h);
  assert.equal(await h.compaction.arm(live.target, 500), true);
  assert.equal(settingsLimit(live.session), 500);

  const abandoned = primaryTarget(h, 'abandoned');
  abandoned.setCurrent(false);
  assert.equal(await h.compaction.arm(abandoned.target, 600), false);
  assert.equal(abandoned.session.settings.length, 0);

  const pending = primaryTarget(h, 'pending');
  const gate = pending.session.deferNextUpdateSettings();
  const arming = h.compaction.arm(pending.target, 700);
  pending.setCurrent(false);
  gate.resolve();
  assert.equal(await arming, false);
});

test('provider rejection is best effort and clears a truthful primary limit', async () => {
  const h = createHarness();
  const primary = primaryTarget(h);
  primary.session.nextUpdateSettingsError = new Error('provider rejected');
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await h.compaction.rearmPrimary(primary.target);
  } finally {
    console.error = originalError;
  }
  assert.equal(h.patches.at(-1)?.appSessionId, 'app-1');
  assert.equal(h.patches.at(-1)?.patch.compactionTokenLimit, undefined);
});

test('global retune uses each captured effective model and publishes only primary state', async () => {
  const h = createHarness();
  const primary = primaryTarget(h, 'app-1', 'primary-model');
  const child = childTarget(h, 'loaded-child-model');
  await h.compaction.updateLimits(
    {
      compactionTokenLimit: 750,
      compactionTokenLimitPerModel: {
        'primary-model': 300,
        'loaded-child-model': 450,
      },
    },
    [primary.target, child.target],
  );
  assert.equal(settingsLimit(primary.session), 300);
  assert.equal(settingsLimit(child.session), 450);
  assert.deepEqual(h.patches, [{ appSessionId: 'app-1', patch: { compactionTokenLimit: 300 } }]);
});

test('a superseded revision stops before provider issue', async () => {
  const h = createHarness();
  const primary = primaryTarget(h);
  const firstDefaults = deferredDefaults();
  h.setDefaultsReader(() => firstDefaults.promise);
  const first = h.compaction.updateLimits({ compactionTokenLimit: 300 }, [primary.target]);
  await Promise.resolve();

  h.setDefaultsReader(() => Promise.resolve({ compactionTokenLimit: 900 }));
  await h.compaction.updateLimits({ compactionTokenLimit: 500 }, [primary.target]);
  firstDefaults.resolve();
  await first;

  assert.deepEqual(
    primary.session.settings.map((settings) => settings['compactionTokenLimit']),
    [500],
  );
  assert.deepEqual(
    h.patches.map(({ patch }) => patch.compactionTokenLimit),
    [500],
  );
});

test('a superseded issued write cannot publish stale primary state', async () => {
  const h = createHarness();
  const primary = primaryTarget(h);
  const firstWrite = primary.session.deferNextUpdateSettings();
  const first = h.compaction.updateLimits({ compactionTokenLimit: 300 }, [primary.target]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(primary.session.settings.length, 1);

  await h.compaction.updateLimits({ compactionTokenLimit: 500 }, [primary.target]);
  firstWrite.resolve();
  await first;

  assert.deepEqual(
    primary.session.settings.map((settings) => settings['compactionTokenLimit']),
    [300, 500],
  );
  assert.deepEqual(
    h.patches.map(({ patch }) => patch.compactionTokenLimit),
    [500],
  );
});

test('child close and old-model replacement invalidate unresolved writes', async () => {
  const h = createHarness();
  const closing = childTarget(h, 'old-model');
  const closeDefaults = deferredDefaults();
  h.setDefaultsReader(() => closeDefaults.promise);
  const closingRetune = h.compaction.updateLimits({ compactionTokenLimit: 500 }, [closing.target]);
  closing.setCurrent(false);
  closeDefaults.resolve();
  await closingRetune;
  assert.equal(closing.session.settings.length, 0);

  const changing = childTarget(h, 'old-model');
  const oldDefaults = deferredDefaults();
  h.setDefaultsReader(() => oldDefaults.promise);
  const oldRetune = h.compaction.updateLimits(
    {
      compactionTokenLimitPerModel: { 'old-model': 300, 'new-model': 600 },
    },
    [changing.target],
  );
  changing.setModel('new-model');
  const replacement = childTarget(h, 'new-model');
  h.setDefaultsReader(() => Promise.resolve({}));
  await h.compaction.rearmModelChangedChild(replacement.target, 'new-model');
  oldDefaults.resolve();
  await oldRetune;
  assert.equal(changing.session.settings.length, 0);
  assert.equal(settingsLimit(replacement.session), 600);
});

test('child invalidation immediately before provider arm prevents the write', async () => {
  const h = createHarness();
  const child = childTarget(h, 'model-a');
  let checks = 0;
  const target: ChildCompactionTarget = {
    ...child.target,
    isCurrent: () => {
      checks += 1;
      return checks < 3;
    },
  };

  await h.compaction.rearmModelChangedChild(target, 'model-a');

  assert.equal(checks, 3);
  assert.deepEqual(child.session.settings, []);
});

test('clearAll invalidates unresolved policy work and provider arming', async () => {
  const h = createHarness();
  const primary = primaryTarget(h);
  const defaults = deferredDefaults();
  h.setDefaultsReader(() => defaults.promise);
  const retune = h.compaction.rearmPrimary(primary.target);
  h.compaction.clearAll();
  h.compaction.clearAll();
  defaults.resolve();
  await retune;
  assert.equal(primary.session.settings.length, 0);
  assert.equal(h.patches.length, 0);

  const pending = primaryTarget(h, 'pending-clear');
  const gate: StreamGate = pending.session.deferNextUpdateSettings();
  h.setDefaultsReader(() => Promise.resolve({}));
  const arming = h.compaction.arm(pending.target, 400);
  h.compaction.clearAll();
  gate.resolve();
  assert.equal(await arming, false);
});
