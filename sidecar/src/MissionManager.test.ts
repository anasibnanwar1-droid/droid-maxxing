import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAutonomyForCommand,
  createMissionAgentDefaultsForMode,
  createModelDefaultsForMode,
  createSessionSettingsForAgent,
  MissionManager,
  startupFactoryDefaults,
  validateFactoryDefaults,
} from './MissionManager.js';
import {
  clampCompactionTokenLimit,
  compactionTokenLimitForModel,
  createCompactionSettingsForModel,
  effectiveCompactionLimit,
  resumedCompactionTokenLimit,
} from './compaction.js';
import { RESUME_NUDGE } from './autoCompaction.js';
import type {
  BridgeFeature,
  MissionSummary,
  ModelInfo,
  ServerEvent,
  WorkerHistoryLink,
} from './protocol.js';

class FakeSession {
  prompts: string[] = [];
  interrupts = 0;
  settingsUpdates: Array<Record<string, unknown>> = [];
  private releaseFirstTurn?: () => void;

  constructor(readonly sessionId: string) {}

  async *stream(prompt: string): AsyncGenerator<never, void, undefined> {
    this.prompts.push(prompt);
    if (prompt !== 'first') return;
    await new Promise<void>((resolve) => {
      this.releaseFirstTurn = resolve;
    });
    throw new Error('interrupted');
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    this.releaseFirstTurn?.();
  }

  async updateSettings(params: Record<string, unknown>): Promise<void> {
    this.settingsUpdates.push(params);
  }

  async getContextStats(): Promise<{
    used: number;
    remaining: number;
    limit: number;
    accuracy: 'exact';
    updatedAt: string;
  }> {
    return {
      used: 0,
      remaining: 100_000,
      limit: 100_000,
      accuracy: 'exact',
      updatedAt: new Date().toISOString(),
    };
  }
}

class FakeAgentSession {
  closed = false;
  notify?: (note: Record<string, unknown>) => void;
  settingsUpdates: Array<Record<string, unknown>> = [];
  constructor(readonly sessionId: string) {}
  onNotification(cb: (note: Record<string, unknown>) => void): () => void {
    this.notify = cb;
    return () => {
      this.notify = undefined;
    };
  }
  async updateSettings(params: Record<string, unknown>): Promise<void> {
    this.settingsUpdates.push(params);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function testSummary(id: string, sessionId: string): MissionSummary {
  const now = Date.now();
  return {
    id,
    sessionId,
    kind: 'chat',
    role: 'orchestrator',
    title: 'Test session',
    goal: 'Test goal',
    cwd: '',
    workspaceKind: 'none',
    autonomy: 'medium',
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

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for condition');
}

test('uses Factory default autonomy when create command omits autonomy', () => {
  assert.equal(createAutonomyForCommand({}, { autonomy: 'high' }), 'high');
});

test('uses explicit session autonomy ahead of Factory default autonomy', () => {
  assert.equal(createAutonomyForCommand({ autonomy: 'low' }, { autonomy: 'high' }), 'low');
});

test('uses mission orchestrator defaults for AGI missions', () => {
  assert.deepEqual(
    createModelDefaultsForMode(
      'agi',
      {},
      {
        modelId: 'default-model',
        reasoningEffort: 'medium',
        missionOrchestratorModelId: 'mission-model',
        missionOrchestratorReasoningEffort: 'high',
      },
    ),
    { modelId: 'mission-model', reasoningEffort: 'high' },
  );
});

test('uses regular session defaults for normal chat', () => {
  assert.deepEqual(
    createModelDefaultsForMode(
      'auto',
      {},
      {
        modelId: 'default-model',
        reasoningEffort: 'medium',
        missionOrchestratorModelId: 'mission-model',
        missionOrchestratorReasoningEffort: 'high',
      },
    ),
    { modelId: 'default-model', reasoningEffort: 'medium' },
  );
});

test('uses worker and validator defaults only for Mission Control sessions', () => {
  const defaults = {
    workerModelId: 'worker-default',
    workerReasoningEffort: 'medium' as const,
    validatorModelId: 'validator-default',
    validatorReasoningEffort: 'high' as const,
  };

  assert.deepEqual(
    createMissionAgentDefaultsForMode(
      'agi',
      {
        workerModel: 'worker-custom',
        workerReasoning: 'low',
      },
      defaults,
    ),
    {
      workerModelId: 'worker-custom',
      workerReasoningEffort: 'low',
      validatorModelId: 'validator-default',
      validatorReasoningEffort: 'high',
    },
  );
  assert.deepEqual(createMissionAgentDefaultsForMode('auto', {}, defaults), {});
  assert.deepEqual(createMissionAgentDefaultsForMode('spec', {}, defaults), {});
});

test('uses per-model compaction limit ahead of global limits', () => {
  assert.equal(
    compactionTokenLimitForModel(
      'model-b',
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-b': 800_000 } },
      { compactionTokenLimit: 100_000, compactionTokenLimitPerModel: { 'model-b': 300_000 } },
    ),
    800_000,
  );
});

test('uses Factory compaction defaults when command omits them', () => {
  assert.equal(
    compactionTokenLimitForModel('model-a', {}, { compactionTokenLimit: 200_000 }),
    200_000,
  );
});

test('effectiveCompactionLimit falls back to the model window when no explicit limit is set', () => {
  // No explicit limit -> the auto-compaction trigger basis is the model window
  // (compact at ~80% of it) rather than undefined (which disables compaction).
  assert.equal(effectiveCompactionLimit('model-a', {}, 200_000), 200_000);
  // An explicit limit still wins and is clamped to the window.
  assert.equal(
    effectiveCompactionLimit('model-a', { compactionTokenLimit: 100_000 }, 200_000),
    100_000,
  );
  assert.equal(
    effectiveCompactionLimit('model-a', { compactionTokenLimit: 500_000 }, 200_000),
    200_000,
  );
  // Unknown window and no explicit limit -> nothing to trigger on.
  assert.equal(effectiveCompactionLimit('model-a', {}, undefined), undefined);
});

test('builds Droid compaction init payloads', () => {
  assert.deepEqual(
    createCompactionSettingsForModel('model-a', {
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'model-a': 150_000 },
    }),
    {
      compactionTokenLimit: 150_000,
    },
  );
});

test('caps Droid compaction limits to the selected model context window', () => {
  assert.equal(clampCompactionTokenLimit(200_000, 100_000), 100_000);
  assert.equal(clampCompactionTokenLimit(80_000, 100_000), 80_000);
  assert.equal(clampCompactionTokenLimit(200_000), 200_000);
  assert.deepEqual(
    createCompactionSettingsForModel(
      'model-a',
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-a': 150_000 } },
      {},
      100_000,
    ),
    {
      compactionTokenLimit: 100_000,
    },
  );
});

test('leaves unset compaction limits to Factory session defaults', () => {
  assert.deepEqual(
    createCompactionSettingsForModel(
      'model-a',
      { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
      {},
      100_000,
    ),
    {},
  );
});

test('resume threshold honors an init-exposed compaction limit ahead of current defaults', () => {
  // When the resumed SDK init settings expose a compactionTokenLimit, it wins
  // over the current Factory defaults.
  assert.equal(
    clampCompactionTokenLimit(
      resumedCompactionTokenLimit(
        'model-a',
        { compactionTokenLimit: 120_000, compactionTokenLimitPerModel: undefined },
        { compactionTokenLimit: 200_000 },
      ),
      500_000,
    ),
    120_000,
  );
});

test('resume threshold honors an init-exposed global limit over a current default per-model limit', () => {
  // The resumed session exposes only a global limit; a current per-model default
  // must not override the session's own saved limit (regression: the plain
  // helper preferred the default per-model entry first).
  assert.equal(
    resumedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimit: 120_000, compactionTokenLimitPerModel: undefined },
      { compactionTokenLimitPerModel: { 'model-a': 200_000 } },
    ),
    120_000,
  );
  // Sanity check that the plain helper is what exhibited the override.
  assert.equal(
    compactionTokenLimitForModel(
      'model-a',
      { compactionTokenLimit: 120_000, compactionTokenLimitPerModel: undefined },
      { compactionTokenLimitPerModel: { 'model-a': 200_000 } },
    ),
    200_000,
  );
});

test('resume threshold falls back to current defaults when init omits a compaction limit', () => {
  // The SDK does not persist a per-session compactionTokenLimit, so an init
  // without one follows the current app defaults (including per-model).
  assert.equal(
    clampCompactionTokenLimit(
      resumedCompactionTokenLimit(
        'model-a',
        { compactionTokenLimit: undefined, compactionTokenLimitPerModel: undefined },
        { compactionTokenLimit: 200_000 },
      ),
      500_000,
    ),
    200_000,
  );
  // A current per-model default still applies when init exposes nothing.
  assert.equal(
    resumedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimit: undefined, compactionTokenLimitPerModel: undefined },
      { compactionTokenLimitPerModel: { 'model-a': 175_000 } },
    ),
    175_000,
  );
});

test('withLiveWorkerStatus annotates live links and leaves historical/unknown ones untouched', () => {
  const manager = new MissionManager(() => {});
  const mission = {
    summary: testSummary('app-live', 'droid-live'),
    knownSubagents: new Set(['run-1', 'done-1']),
    completedSubagents: new Set(['done-1']),
    // A resumed worker the user has opened is live in agents but not in
    // knownSubagents (which only a live spawn populates).
    agents: new Map<string, unknown>([['open-1', {}]]),
  };
  const internals = manager as unknown as {
    missions: Map<string, typeof mission>;
    withLiveWorkerStatus: (id: string, links: WorkerHistoryLink[]) => WorkerHistoryLink[];
  };
  internals.missions.set(mission.summary.id, mission);
  const out = internals.withLiveWorkerStatus(mission.summary.id, [
    { workerSessionId: 'run-1', toolUseId: 't1' },
    { workerSessionId: 'done-1', toolUseId: 't2' },
    { workerSessionId: 'open-1', toolUseId: 't3' },
    { workerSessionId: 'gone-1', toolUseId: 't4' },
  ]);
  assert.equal(out.find((l) => l.workerSessionId === 'run-1')?.status, 'running');
  assert.equal(out.find((l) => l.workerSessionId === 'done-1')?.status, 'completed');
  // An opened resumed worker (in agents only) is marked running, not completed.
  assert.equal(out.find((l) => l.workerSessionId === 'open-1')?.status, 'running');
  assert.equal(out.find((l) => l.workerSessionId === 'gone-1')?.status, undefined);
});

test('agentBelongsToMission accepts persisted-linked subagents for chat/spec missions', () => {
  const manager = new MissionManager(() => {});
  const mission = {
    summary: testSummary('app-linked', 'droid-linked'),
    knownSubagents: new Set<string>(),
    linkedSubagents: new Set(['hist-worker-1']),
  };
  const internals = manager as unknown as {
    agentBelongsToMission: (m: typeof mission, id: string) => boolean;
  };
  // A historical subagent known only from a persisted link is still openable.
  assert.equal(internals.agentBelongsToMission(mission, 'hist-worker-1'), true);
  assert.equal(internals.agentBelongsToMission(mission, 'unknown-worker'), false);
});

test('rekeyAgentSession adopts the swapped worker id across all mission state', async () => {
  const manager = new MissionManager(() => {});
  const oldSession = new FakeAgentSession('worker-old');
  const newSession = new FakeAgentSession('worker-new');
  let unsubscribed = 0;
  const agent = {
    session: oldSession,
    missionId: 'app-rk',
    role: 'worker' as const,
    streaming: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
    unsubscribe: () => {
      unsubscribed += 1;
    },
  };
  const mission = {
    summary: testSummary('app-rk', 'droid-rk'),
    agents: new Map<string, typeof agent>([['worker-old', agent]]),
    knownSubagents: new Set(['worker-old']),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set(['worker-old']),
    subagentToolUseIds: new Map([['tool-rk', 'worker-old']]),
    subagentSettings: new Map([['worker-old', { modelId: 'm-worker' }]]),
  };
  const recorded: Array<{ toolUseId: string; workerSessionId: string; label?: string }> = [];
  const internals = manager as unknown as {
    runtime: { loadSession: (id: string, handlers: unknown) => Promise<FakeAgentSession> };
    history: {
      subagentLinks: () => WorkerHistoryLink[];
      recordSubagentLink: (m: string, t: string, w: string, l?: string) => void;
    };
    contextSnapshots: Map<string, unknown>;
    missions: Map<string, typeof mission>;
    compaction: { rekeyAgentSession: (a: typeof agent, newId: string) => Promise<void> };
  };
  internals.runtime = { loadSession: async () => newSession };
  internals.history = {
    subagentLinks: () => [
      { workerSessionId: 'worker-old', toolUseId: 'tool-rk', label: 'Builder' },
    ],
    recordSubagentLink: (_m, t, w, l) =>
      recorded.push({ toolUseId: t, workerSessionId: w, label: l }),
  };
  internals.contextSnapshots.set('worker-old', { used: 5 });
  internals.missions.set('app-rk', mission);

  await internals.compaction.rekeyAgentSession(agent, 'worker-new');

  assert.equal(agent.session.sessionId, 'worker-new');
  assert.equal(unsubscribed, 1);
  assert.equal(oldSession.closed, true);
  assert.equal(mission.agents.has('worker-old'), false);
  assert.equal(mission.agents.get('worker-new'), agent);
  assert.ok(mission.knownSubagents.has('worker-new') && !mission.knownSubagents.has('worker-old'));
  assert.ok(
    mission.linkedSubagents.has('worker-new') && !mission.linkedSubagents.has('worker-old'),
  );
  assert.equal(mission.subagentToolUseIds.get('tool-rk'), 'worker-new');
  assert.equal(mission.subagentSettings.get('worker-new')?.modelId, 'm-worker');
  assert.equal(internals.contextSnapshots.has('worker-old'), false);
  assert.deepEqual(internals.contextSnapshots.get('worker-new'), { used: 5 });
  // The spawn link is re-pointed at the new id while preserving its label.
  assert.deepEqual(recorded, [
    { toolUseId: 'tool-rk', workerSessionId: 'worker-new', label: 'Builder' },
  ]);
});

test('persistWorkerSwap carries per-session model settings to the new id (stale-recovery path)', async () => {
  const manager = new MissionManager(() => {});
  const mission = {
    summary: testSummary('app-psw', 'droid-psw'),
    agents: new Map(),
    knownSubagents: new Set(['worker-old']),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set(['worker-old']),
    subagentToolUseIds: new Map<string, string>(),
    // The user picked a specific model for this worker.
    subagentSettings: new Map<string, { modelId?: string }>([
      ['worker-old', { modelId: 'm-pick' }],
    ]),
  };
  const internals = manager as unknown as {
    history: { subagentLinks: () => WorkerHistoryLink[] };
    missions: Map<string, typeof mission>;
    compaction: { persistWorkerSwap: (m: typeof mission, oldId: string, newId: string) => void };
  };
  internals.history = { subagentLinks: () => [] };
  internals.missions.set('app-psw', mission);

  // The double-failure recovery path persists the swap without a successful
  // rekey (which is what would otherwise have moved subagentSettings).
  internals.compaction.persistWorkerSwap(mission, 'worker-old', 'worker-new');

  // Without the fix the new id has no stored settings and a re-opened worker
  // silently reverts to the role-default model instead of the user's pick.
  assert.equal(mission.subagentSettings.get('worker-new')?.modelId, 'm-pick');
  assert.equal(mission.subagentSettings.has('worker-old'), false);
});

test('worker compaction re-keys to the new backing id and emits a rekey event (not stale)', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const oldSession = new FakeCompactionSession('worker-old', 900_000, 'worker-new');
  const newSession = new FakeCompactionSession('worker-new', 10_000);
  const agent = {
    session: oldSession,
    missionId: 'app-cmp',
    role: 'worker' as const,
    streaming: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
    unsubscribe: () => {},
    effectiveCompactionTokenLimit: 200_000,
  };
  const mission = {
    summary: testSummary('app-cmp', 'droid-cmp'),
    agents: new Map<string, typeof agent>([['worker-old', agent]]),
    knownSubagents: new Set(['worker-old']),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set<string>(),
    subagentToolUseIds: new Map([['tool-cmp', 'worker-old']]),
    subagentSettings: new Map<string, { modelId?: string }>(),
  };
  const internals = manager as unknown as {
    runtime: { loadSession: (id: string, handlers: unknown) => Promise<FakeCompactionSession> };
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      subagentLinks: () => WorkerHistoryLink[];
      recordSubagentLink: () => void;
    };
    missions: Map<string, typeof mission>;
    compaction: { compactAgent: (a: typeof agent, t: 'auto' | 'manual') => Promise<string> };
  };
  internals.runtime = { loadSession: async () => newSession };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    subagentLinks: () => [{ workerSessionId: 'worker-old', toolUseId: 'tool-cmp' }],
    recordSubagentLink: () => {},
  };
  internals.missions.set('app-cmp', mission);

  const outcome = await internals.compaction.compactAgent(agent, 'auto');

  // The swap is adopted in place: completed (not stale), worker stays alive.
  assert.equal(outcome, 'completed');
  assert.equal(agent.session.sessionId, 'worker-new');
  assert.equal(mission.agents.has('worker-new'), true);
  assert.equal(mission.agents.has('worker-old'), false);
  const rekey = events.find((e) => e.type === 'mission.worker.rekey') as
    | { missionId: string; oldSessionId: string; newSessionId: string }
    | undefined;
  assert.deepEqual(
    rekey && {
      missionId: rekey.missionId,
      oldSessionId: rekey.oldSessionId,
      newSessionId: rekey.newSessionId,
    },
    {
      missionId: 'app-cmp',
      oldSessionId: 'worker-old',
      newSessionId: 'worker-new',
    },
  );
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
});

test('worker compaction re-applies the worker model so it does not revert to the CLI default', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const oldSession = new FakeCompactionSession('worker-old', 900_000, 'worker-new');
  const newSession = new FakeCompactionSession('worker-new', 10_000);
  const agent = {
    session: oldSession,
    missionId: 'app-wm',
    role: 'worker' as const,
    streaming: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
    unsubscribe: () => {},
    effectiveCompactionTokenLimit: 200_000,
  };
  const mission = {
    summary: testSummary('app-wm', 'droid-wm'),
    agents: new Map<string, typeof agent>([['worker-old', agent]]),
    knownSubagents: new Set(['worker-old']),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set<string>(),
    subagentToolUseIds: new Map<string, string>(),
    subagentSettings: new Map<string, { modelId?: string; reasoningEffort?: string }>([
      ['worker-old', { modelId: 'custom:glm-5.2', reasoningEffort: 'high' }],
    ]),
  };
  const internals = manager as unknown as {
    runtime: { loadSession: (id: string, handlers: unknown) => Promise<FakeCompactionSession> };
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      subagentLinks: () => WorkerHistoryLink[];
      recordSubagentLink: () => void;
    };
    missions: Map<string, typeof mission>;
    compaction: { compactAgent: (a: typeof agent, t: 'auto' | 'manual') => Promise<string> };
  };
  internals.runtime = { loadSession: async () => newSession };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    subagentLinks: () => [],
    recordSubagentLink: () => {},
  };
  internals.missions.set('app-wm', mission);

  const outcome = await internals.compaction.compactAgent(agent, 'auto');

  assert.equal(outcome, 'completed');
  assert.equal(agent.session.sessionId, 'worker-new');
  // The worker's selected model + reasoning are re-applied to the compacted
  // session: loadSession cannot carry them, so without this the worker would
  // silently fall back to the daemon's CLI-default model.
  const applied = newSession.settingsUpdates.find((u) => 'modelId' in u);
  assert.ok(applied, 'expected updateSettings to re-apply the worker model after the swap');
  assert.equal(applied?.modelId, 'custom:glm-5.2');
  assert.equal(applied?.reasoningEffort, 'high');
});

test('worker notification subscription drops events while a compaction interrupt is armed', async () => {
  const manager = new MissionManager(() => {});
  const oldSession = new FakeAgentSession('worker-old');
  const newSession = new FakeAgentSession('worker-new');
  const agent = {
    session: oldSession,
    missionId: 'app-guard',
    role: 'worker' as const,
    streaming: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
    interruptingForCompaction: false,
    unsubscribe: () => {},
  };
  const mission = {
    summary: testSummary('app-guard', 'droid-guard'),
    agents: new Map<string, typeof agent>([['worker-old', agent]]),
    knownSubagents: new Set(['worker-old']),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set<string>(),
    subagentToolUseIds: new Map<string, string>(),
    subagentSettings: new Map<string, { modelId?: string }>(),
  };
  let applied = 0;
  const internals = manager as unknown as {
    runtime: { loadSession: (id: string, h: unknown) => Promise<FakeAgentSession> };
    history: { subagentLinks: () => WorkerHistoryLink[]; recordSubagentLink: () => void };
    contextSnapshots: Map<string, unknown>;
    missions: Map<string, typeof mission>;
    applyNormalizedForAgent: (m: string, s: string, n: unknown) => void;
    compaction: { rekeyAgentSession: (a: typeof agent, id: string) => Promise<void> };
  };
  internals.runtime = { loadSession: async () => newSession };
  internals.history = { subagentLinks: () => [], recordSubagentLink: () => {} };
  internals.missions.set('app-guard', mission);
  internals.applyNormalizedForAgent = () => {
    applied += 1;
  };

  await internals.compaction.rekeyAgentSession(agent, 'worker-new');
  assert.ok(newSession.notify, 'expected the worker notification subscription to be registered');

  const note = { type: 'assistant_text_delta', messageId: 'm1', blockIndex: 0, textDelta: 'hi' };
  // Disarmed: the tail event flows through to the shared agent entry.
  newSession.notify?.(note);
  assert.equal(applied, 1);
  // Armed for compaction: the event is dropped before it can mark the worker
  // terminal and make the pending compaction skip.
  agent.interruptingForCompaction = true;
  newSession.notify?.(note);
  assert.equal(applied, 1);
});

test('refreshContext clears a saturated worker latch once its context fits again', async () => {
  const manager = new MissionManager(() => {});
  const session = new FakeCompactionSession('worker-1', 10_000);
  const agent = {
    session,
    missionId: 'app-sat',
    role: 'worker' as const,
    streaming: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
    effectiveCompactionTokenLimit: 200_000,
    compactionSaturated: true,
  };
  const mission = {
    summary: testSummary('app-sat', 'droid-sat'),
    agents: new Map<string, typeof agent>([['worker-1', agent]]),
  };
  const internals = manager as unknown as {
    missions: Map<string, typeof mission>;
    refreshContext: (id: string, s: FakeCompactionSession) => Promise<void>;
  };
  internals.missions.set('app-sat', mission);

  // refreshContext only receives a session id; findMission misses the worker, so
  // the latch must clear via the cross-mission live-agent lookup.
  await internals.refreshContext('worker-1', session);
  assert.equal(agent.compactionSaturated, false);
});

test('a stale worker pre-turn compaction re-delivers the queued prompt to the swapped session', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const oldSession = new FakeCompactionSession('worker-old', 900_000, 'worker-new');
  const agent = {
    session: oldSession,
    missionId: 'app-redel',
    role: 'worker' as const,
    streaming: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
    unsubscribe: () => {},
    effectiveCompactionTokenLimit: 200_000,
  };
  const mission = {
    summary: testSummary('app-redel', 'droid-redel'),
    agents: new Map<string, typeof agent>([['worker-old', agent]]),
    knownSubagents: new Set(['worker-old']),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set(['worker-old']),
    subagentToolUseIds: new Map<string, string>([['tool-redel', 'worker-old']]),
    subagentSettings: new Map<string, { modelId?: string }>(),
  };
  const redelivered: Array<{ missionId: string; sessionId: string; text: string }> = [];
  const internals = manager as unknown as {
    runtime: { loadSession: () => Promise<never> };
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      subagentLinks: () => WorkerHistoryLink[];
      recordSubagentLink: () => void;
    };
    contextSnapshots: Map<string, { used: number; limit: number }>;
    missions: Map<string, typeof mission>;
    sendAgent: (m: string, s: string, t: string) => Promise<void>;
    compaction: { compactAgentBeforeTurnIfDue: (a: typeof agent, t: string) => Promise<boolean> };
  };
  // Adoption fails on every load, so the swap goes stale (daemon swapped to
  // worker-new but it could not be adopted in place).
  internals.runtime = {
    loadSession: async () => {
      throw new Error('adoption failed');
    },
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    subagentLinks: () => [],
    recordSubagentLink: () => {},
  };
  internals.contextSnapshots.set('worker-old', { used: 900_000, limit: 1_000_000 });
  internals.missions.set('app-redel', mission);
  internals.sendAgent = async (m, s, t) => {
    redelivered.push({ missionId: m, sessionId: s, text: t });
  };

  const handled = await internals.compaction.compactAgentBeforeTurnIfDue(agent, 'steer me');
  assert.equal(handled, true);
  // The dead-id worker is torn down, but the steering prompt is re-delivered to
  // the persisted (compacted) session id rather than silently dropped.
  assert.deepEqual(redelivered, [
    { missionId: 'app-redel', sessionId: 'worker-new', text: 'steer me' },
  ]);
});

test('withLiveWorkerStatus leaves links untouched for historical (non-live) missions', () => {
  const manager = new MissionManager(() => {});
  const internals = manager as unknown as {
    withLiveWorkerStatus: (id: string, links: WorkerHistoryLink[]) => WorkerHistoryLink[];
  };
  const links: WorkerHistoryLink[] = [{ workerSessionId: 'w1', toolUseId: 't1' }];
  assert.deepEqual(internals.withLiveWorkerStatus('not-live', links), links);
});

test('sendNow interrupts the live turn and prioritizes the steering prompt', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeSession('droid-1');
  const mission = {
    summary: testSummary('app-1', session.sessionId),
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set(),
    completedSubagents: new Set(),
    terminalAgents: new Set(),
    linkedSubagents: new Set(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    compacting: false,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  internals.missions.set(mission.summary.id, mission);

  const firstTurn = manager.handle({
    type: 'mission.send',
    missionId: mission.summary.id,
    text: 'first',
  });
  await waitFor(() => session.prompts.includes('first'));

  await manager.handle({ type: 'mission.send', missionId: mission.summary.id, text: 'queued' });
  await manager.handle({ type: 'mission.sendNow', missionId: mission.summary.id, text: 'now' });

  await waitFor(() => session.prompts.length >= 3);
  await firstTurn;

  assert.equal(session.interrupts, 1);
  assert.deepEqual(session.prompts, ['first', 'now', 'queued']);
  assert.equal(mission.pendingSends.length, 0);
  assert.equal(
    events.some((event) => event.type === 'mission.error' || event.type === 'error'),
    false,
  );
});

test('sendNow queues during compaction instead of driving or interrupting', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeSession('droid-compact-now');
  const mission = {
    summary: testSummary('app-compact-now', session.sessionId),
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set(),
    completedSubagents: new Set(),
    terminalAgents: new Set(),
    linkedSubagents: new Set(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    compacting: true,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  internals.missions.set(mission.summary.id, mission);

  // Manual compaction (compacting=true, streaming=false): must not drive() concurrently.
  await manager.handle({
    type: 'mission.sendNow',
    missionId: mission.summary.id,
    text: 'steer-manual',
  });
  assert.deepEqual(session.prompts, []);
  assert.equal(session.interrupts, 0);

  // Auto-compaction (compacting=true, streaming=true): must not interrupt the compaction.
  mission.streaming = true;
  await manager.handle({
    type: 'mission.sendNow',
    missionId: mission.summary.id,
    text: 'steer-auto',
  });
  assert.equal(session.interrupts, 0);

  // Both steers are preserved at the front of the queue for delivery after compaction.
  assert.deepEqual(mission.pendingSends, ['steer-auto', 'steer-manual']);
  assert.equal(
    events.some((event) => event.type === 'mission.error' || event.type === 'error'),
    false,
  );
});

test('design turns disable TodoWrite and normal turns restore it', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeSession('droid-design');
  const mission = {
    summary: testSummary('app-design', session.sessionId),
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set(),
    completedSubagents: new Set(),
    terminalAgents: new Set(),
    linkedSubagents: new Set(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    compacting: false,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  internals.missions.set(mission.summary.id, mission);

  const designPrompt =
    'Design Mode reference pack:\n- URL: about:blank\n\nUser instruction:\nMake the hero cleaner';

  // First normal turn (flag uninitialized) must still call updateSettings to
  // ensure TodoWrite is enabled — the session might have it disabled from a
  // prior design turn before the in-memory flag was lost to a page reload.
  await manager.handle({
    type: 'mission.send',
    missionId: mission.summary.id,
    text: 'just a normal question',
  });
  await waitFor(() => session.prompts.includes('just a normal question'));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: [] });

  // Design turn disables TodoWrite.
  await manager.handle({ type: 'mission.send', missionId: mission.summary.id, text: designPrompt });
  await waitFor(() => session.prompts.includes(designPrompt));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: ['TodoWrite'] });

  // Normal turn restores it.
  await manager.handle({
    type: 'mission.send',
    missionId: mission.summary.id,
    text: 'another normal one',
  });
  await waitFor(() => session.prompts.includes('another normal one'));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: [] });

  // A second design turn re-disables it after the normal turn restored it.
  await manager.handle({
    type: 'mission.send',
    missionId: mission.summary.id,
    text: `${designPrompt} again`,
  });
  await waitFor(() => session.prompts.includes(`${designPrompt} again`));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: ['TodoWrite'] });
  assert.equal(
    events.some((event) => event.type === 'mission.error' || event.type === 'error'),
    false,
  );
});

test('does not emit live compaction disable payloads', () => {
  assert.deepEqual(
    createCompactionSettingsForModel('model-a', {
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: {},
    }),
    {},
  );
});

test('maps mission worker settings to Droid mission settings', () => {
  assert.deepEqual(
    createSessionSettingsForAgent('worker', { modelId: 'worker-model', reasoningEffort: 'high' }),
    {
      missionSettings: {
        workerModel: 'worker-model',
        workerReasoningEffort: 'high',
      },
    },
  );
});

test('maps orchestrator model changes with current compaction limits', () => {
  assert.deepEqual(
    createSessionSettingsForAgent('orchestrator', {
      modelId: 'model-b',
    }),
    {
      modelId: 'model-b',
    },
  );
});

const models: ModelInfo[] = [
  {
    id: 'model-a',
    displayName: 'Model A',
    isDefault: true,
    isCustom: false,
    supportedReasoningEfforts: ['low', 'medium'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'model-b',
    displayName: 'Model B',
    isCustom: false,
    supportedReasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
  },
];

test('startup defaults do not seed unvalidated model ids when no catalog is cached', () => {
  assert.deepEqual(
    startupFactoryDefaults(
      {
        modelId: 'missing-model',
        reasoningEffort: 'high',
        compactionModel: 'missing-model',
        compactionTokenLimit: 200_000,
        compactionTokenLimitPerModel: { 'missing-model': 150_000 },
        autonomy: 'high',
        interactionMode: 'auto',
        workerModelId: 'missing-worker',
      },
      [],
    ),
    {
      autonomy: 'high',
      interactionMode: 'auto',
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'missing-model': 150_000 },
    },
  );
});

test('validates Factory defaults against the model catalog', () => {
  assert.deepEqual(
    validateFactoryDefaults(
      {
        modelId: 'missing-model',
        reasoningEffort: 'high',
        compactionModel: 'missing-model',
        compactionTokenLimit: 200_000,
        compactionTokenLimitPerModel: { 'model-b': 150_000, missing: 90_000 },
        specModelId: 'model-b',
        specReasoningEffort: 'low',
        workerModelId: 'model-b',
        workerReasoningEffort: 'medium',
        validatorModelId: 'missing-validator',
      },
      models,
    ),
    {
      modelId: 'model-a',
      reasoningEffort: 'medium',
      compactionModel: 'current-model',
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'model-b': 150_000 },
      specModelId: 'model-b',
      specReasoningEffort: 'high',
      workerModelId: 'model-b',
      workerReasoningEffort: 'high',
      validatorModelId: 'model-a',
      validatorReasoningEffort: undefined,
    },
  );
});

test('runtime defaults preserve saved model settings when the catalog is unavailable', () => {
  assert.deepEqual(
    validateFactoryDefaults(
      {
        modelId: 'saved-model',
        reasoningEffort: 'high',
        specModelId: 'saved-spec-model',
        workerModelId: 'saved-worker',
        validatorModelId: 'saved-validator',
        compactionModel: 'saved-compaction-model',
        compactionTokenLimit: 200_000.9,
        compactionTokenLimitPerModel: { 'saved-model': 150_000.5 },
      },
      [],
    ),
    {
      modelId: 'saved-model',
      reasoningEffort: 'high',
      specModelId: 'saved-spec-model',
      workerModelId: 'saved-worker',
      validatorModelId: 'saved-validator',
      compactionModel: 'saved-compaction-model',
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'saved-model': 150_000 },
    },
  );
});

class FakeCompactionSession {
  prompts: string[] = [];
  compactions = 0;
  failCompaction = false;
  settingsUpdates: Array<Record<string, unknown>> = [];

  constructor(
    readonly sessionId: string,
    private used: number,
    private swapTo?: string,
  ) {}

  async *stream(prompt: string): AsyncGenerator<never, void, undefined> {
    this.prompts.push(prompt);
  }

  async updateSettings(params: Record<string, unknown>): Promise<void> {
    this.settingsUpdates.push(params);
  }

  onNotification(_cb: (note: Record<string, unknown>) => void): () => void {
    return () => {};
  }

  async getContextStats(): Promise<{
    used: number;
    remaining: number;
    limit: number;
    accuracy: 'exact';
    updatedAt: string;
  }> {
    return {
      used: this.used,
      remaining: Math.max(0, 1_000_000 - this.used),
      limit: 1_000_000,
      accuracy: 'exact',
      updatedAt: new Date().toISOString(),
    };
  }

  async compactSession(): Promise<{ newSessionId: string; removedCount: number }> {
    if (this.failCompaction) throw new Error('transient compaction failure');
    this.compactions += 1;
    return { newSessionId: this.swapTo ?? this.sessionId, removedCount: 4 };
  }

  async close(): Promise<void> {}
}

function autoCompactHarness(used: number, effectiveCompactionTokenLimit?: number) {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeCompactionSession('droid-compact', used);
  const mission = {
    summary: testSummary('app-compact', session.sessionId),
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set(),
    completedSubagents: new Set(),
    terminalAgents: new Set(),
    linkedSubagents: new Set(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    effectiveCompactionTokenLimit: effectiveCompactionTokenLimit,
    compacting: false,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
    contextSnapshots: Map<string, { used: number; limit?: number }>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  // The orchestrator trigger reads the getContextStats snapshot (kept fresh by
  // the context poller / post-turn refresh), the same source as the meter. Seed
  // it so the idle pre-turn check sees the usage the fake reports.
  mission.summary.contextTokens = used;
  internals.contextSnapshots.set('app-compact', { used });
  internals.missions.set(mission.summary.id, mission);
  return { manager, session, events, mission };
}

test('auto-compacts an idle turn once context crosses the effective limit', async () => {
  const { manager, session, events } = autoCompactHarness(250_000, 200_000);
  await manager.handle({ type: 'mission.send', missionId: 'app-compact', text: 'hello' });
  assert.equal(session.compactions, 1);
  assert.equal(
    events.some((event) => event.type === 'mission.error' || event.type === 'error'),
    false,
  );
});

test('compaction failure surfaces a recoverable error and terminal status without failing the mission', async () => {
  const { manager, session, events } = autoCompactHarness(250_000, 200_000);
  session.failCompaction = true;
  await manager.handle({ type: 'mission.send', missionId: 'app-compact', text: 'hello' });
  // Recoverable: a toast error is emitted but the mission is not marked failed.
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
  assert.equal(
    events.some(
      (e) =>
        e.type === 'error' &&
        /could not compact session/i.test((e as { message?: string }).message ?? ''),
    ),
    true,
  );
  // A terminal status clears the in-progress "Compacting..." shimmer.
  assert.equal(
    events.some(
      (e) =>
        e.type === 'mission.transcript' &&
        /could not finish/i.test((e as { event?: { text?: string } }).event?.text ?? ''),
    ),
    true,
  );
});

test('compaction status transcript IDs are unique within the same millisecond', async () => {
  const { manager, events } = autoCompactHarness(250_000, 200_000);
  await manager.handle({ type: 'mission.send', missionId: 'app-compact', text: 'hello' });
  const statusIds = events
    .filter(
      (e) =>
        e.type === 'mission.transcript' &&
        (e as { event?: { kind?: string } }).event?.kind === 'status',
    )
    .map((e) => (e as { event: { id: string } }).event.id);
  // The start ("Compacting conversation...") and terminal status can land in the
  // same ms; their IDs must differ so the UI doesn't drop the terminal one.
  assert.ok(statusIds.length >= 2);
  assert.equal(new Set(statusIds).size, statusIds.length);
});

test('Stop during compaction drops queued sends but does not interrupt the compaction', async () => {
  const { manager, session, mission } = autoCompactHarness(0, undefined);
  mission.compacting = true;
  let interrupts = 0;
  (session as unknown as { interrupt: () => Promise<void> }).interrupt = async () => {
    interrupts += 1;
  };
  // A send during compaction queues instead of driving.
  await manager.handle({ type: 'mission.send', missionId: 'app-compact', text: 'queued' });
  assert.equal(mission.pendingSends.length, 1);
  // Stop must clear the queue but never interrupt the in-flight compaction.
  await manager.handle({ type: 'mission.interrupt', missionId: 'app-compact' });
  assert.equal(interrupts, 0);
  assert.equal(mission.pendingSends.length, 0);
});

test('does not auto-compact when context stays under the effective limit', async () => {
  const { manager, session } = autoCompactHarness(150_000, 200_000);
  await manager.handle({ type: 'mission.send', missionId: 'app-compact', text: 'hello' });
  assert.equal(session.compactions, 0);
});

test('does not auto-compact when effectiveCompactionTokenLimit is unset', async () => {
  const { manager, session } = autoCompactHarness(250_000, undefined);
  await manager.handle({ type: 'mission.send', missionId: 'app-compact', text: 'hello' });
  assert.equal(session.compactions, 0);
});

// getContextStats stays LOW (below the trigger), but the stream emits a
// token-usage event whose contextTokens is cache-inflated far over the window.
// The trigger and meter must read getContextStats only and ignore it, otherwise
// the inflated value re-crosses the trigger between polls and loops compaction.
class FakeInflatedTokenSession {
  prompts: string[] = [];
  compactions = 0;
  interrupts = 0;

  constructor(readonly sessionId: string) {}

  async *stream(prompt: string): AsyncGenerator<Record<string, unknown>, void, undefined> {
    this.prompts.push(prompt);
    yield {
      type: 'token_usage_update',
      inclusiveTokenUsage: { inputTokens: 5_000, outputTokens: 1_000 },
      lastCallTokenUsage: { inputTokens: 0, cacheReadTokens: 250_000 },
    };
    yield { type: 'result' };
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async updateSettings(): Promise<void> {}

  onNotification(): () => void {
    return () => {};
  }

  async getContextStats(): Promise<{
    used: number;
    remaining: number;
    limit: number;
    accuracy: 'exact';
    updatedAt: string;
  }> {
    return {
      used: 40_000,
      remaining: 960_000,
      limit: 1_000_000,
      accuracy: 'exact',
      updatedAt: new Date().toISOString(),
    };
  }

  async compactSession(): Promise<{ newSessionId: string; removedCount: number }> {
    this.compactions += 1;
    return { newSessionId: this.sessionId, removedCount: 4 };
  }

  async close(): Promise<void> {}
}

function inflatedTokenHarness() {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeInflatedTokenSession('droid-inflated');
  const mission = {
    summary: testSummary('app-inflated', session.sessionId),
    session,
    streaming: false,
    pendingSends: [] as string[],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set<string>(),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set<string>(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    effectiveCompactionTokenLimit: 200_000,
    compacting: false,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
    contextSnapshots: Map<string, { used: number; limit?: number }>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  internals.contextSnapshots.set('app-inflated', { used: 40_000, limit: 1_000_000 });
  internals.missions.set(mission.summary.id, mission);
  return { manager, session, events };
}

test('a cache-inflated token-usage event never moves the trigger or compacts (meter uses getContextStats only)', async () => {
  const { manager, session, events } = inflatedTokenHarness();
  await manager.handle({ type: 'mission.send', missionId: 'app-inflated', text: 'go' });
  await waitFor(() => events.some((e) => e.type === 'context.updated'));
  // The inflated 250k token event must not trigger a compaction or interrupt.
  assert.equal(session.compactions, 0);
  assert.equal(session.interrupts, 0);
  // Every context reading reflects the accurate getContextStats value (~40k),
  // never the cache-inflated 250k the old estimate path leaked into the meter.
  const contextUpdates = events.filter(
    (e): e is Extract<ServerEvent, { type: 'context.updated' }> => e.type === 'context.updated',
  );
  assert.ok(contextUpdates.length > 0);
  assert.equal(
    contextUpdates.every((e) => e.stats.used <= 50_000),
    true,
  );
});

test('rejects manual compaction while streaming', async () => {
  const { manager, mission, events } = autoCompactHarness(250_000, 200_000);
  mission.streaming = true;
  await manager.handle({
    type: 'mission.compact',
    missionId: 'app-compact',
    customInstructions: undefined,
  });
  assert.equal(mission.streaming, true);
  const hasRejection = events.some(
    (e) =>
      e.type === 'mission.transcript' &&
      /cannot compact/i.test((e as { event?: { text?: string } }).event?.text ?? ''),
  );
  assert.equal(hasRejection, true);
});

test('a user prompt sent while over the trigger compacts first then runs the user prompt, not a hidden continue', async () => {
  const { manager, session } = autoCompactHarness(250_000, 200_000);
  await manager.handle({
    type: 'mission.send',
    missionId: 'app-compact',
    text: 'real user prompt',
  });
  assert.equal(session.compactions, 1);
  // The user's prompt drives the post-compaction turn; it is never dropped nor
  // replaced by the synthetic resume nudge.
  assert.equal(session.prompts.includes('real user prompt'), true);
  assert.equal(session.prompts.includes(RESUME_NUDGE), false);
});

test('does not compact after a turn that ends over the trigger (no post-turn compaction)', async () => {
  const { manager, session } = autoCompactHarness(250_000, 200_000);
  // The session was under the trigger when the prompt arrived (no pre-turn
  // compaction); the fake then reports usage over the trigger as the turn ends.
  (manager as unknown as { contextSnapshots: Map<string, { used: number }> }).contextSnapshots.set(
    'app-compact',
    { used: 10_000 },
  );
  await manager.handle({ type: 'mission.send', missionId: 'app-compact', text: 'hello' });
  // No post-turn compaction after a final answer: it waits for the next prompt.
  assert.equal(session.compactions, 0);
  assert.equal(session.prompts.includes(RESUME_NUDGE), false);
});

// Simulates a long, still-working turn: it bumps usage over the trigger, yields
// one no-op event so the drive loop runs its between-events compaction check,
// then waits to be interrupted. A resumed turn (the hidden nudge) does no work.
class FakeMidTurnSession {
  prompts: string[] = [];
  interrupts = 0;
  compactions = 0;
  // Controls what the daemon reports for the mid-task compaction so the resume
  // path can be exercised for each non-stale outcome.
  compactBehavior: 'completed' | 'noop' | 'failed' = 'completed';
  // When set, a completed compaction reports a swapped backing id (drives the
  // adopt-in-place / stale-recovery path).
  swapTo?: string;
  // Only the first real turn is the long one that crosses the trigger and waits
  // to be interrupted; resumed/steered turns complete immediately.
  armed = true;
  interrupted = false;
  onTurnStart?: () => void;
  private release?: () => void;

  constructor(readonly sessionId: string) {}

  async *stream(prompt: string): AsyncGenerator<Record<string, unknown>, void, undefined> {
    this.prompts.push(prompt);
    if (prompt === RESUME_NUDGE || !this.armed) return;
    this.armed = false;
    this.onTurnStart?.();
    // A completed step (tool_result with no tool left in flight) is the only safe
    // boundary the client may interrupt on for compaction.
    yield { type: 'tool_result', toolName: 'Read', toolUseId: 'm1', content: 'data' };
    // The interrupt can land while we are paused at the yield (before `release`
    // is set), so check the flag before awaiting to avoid blocking forever.
    if (!this.interrupted) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    throw new Error('interrupted');
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    this.interrupted = true;
    this.release?.();
  }

  async updateSettings(): Promise<void> {}

  onNotification(): () => void {
    return () => {};
  }

  async getContextStats(): Promise<{
    used: number;
    remaining: number;
    limit: number;
    accuracy: 'exact';
    updatedAt: string;
  }> {
    return {
      used: 250_000,
      remaining: 750_000,
      limit: 1_000_000,
      accuracy: 'exact',
      updatedAt: new Date().toISOString(),
    };
  }

  async compactSession(): Promise<{ newSessionId: string; removedCount: number } | null> {
    this.compactions += 1;
    // 'failed' models a transient compaction error; 'noop' models the daemon
    // finding nothing to compact. In both the session stays usable, so the
    // interrupted turn must still resume rather than silently stall.
    if (this.compactBehavior === 'failed') throw new Error('compaction failed transiently');
    if (this.compactBehavior === 'noop') return null;
    return { newSessionId: this.swapTo ?? this.sessionId, removedCount: 4 };
  }

  async close(): Promise<void> {}
}

function midTurnHarness() {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeMidTurnSession('droid-mid');
  const mission = {
    summary: testSummary('app-mid', session.sessionId),
    compactionSaturated: false as boolean | undefined,
    session,
    streaming: false,
    pendingSends: [] as string[],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set<string>(),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set<string>(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    effectiveCompactionTokenLimit: 200_000,
    compacting: false,
    autoContinueCount: undefined as number | undefined,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
    contextSnapshots: Map<string, { used: number; limit?: number }>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  // The trigger reads the getContextStats snapshot. Seed it under the trigger so
  // pre-turn compaction does NOT fire, then have onTurnStart push it over the
  // trigger synchronously so the in-flight turn is interrupted mid-stream.
  internals.contextSnapshots.set('app-mid', { used: 10_000, limit: 1_000_000 });
  session.onTurnStart = () => {
    internals.contextSnapshots.set('app-mid', { used: 250_000, limit: 1_000_000 });
  };
  internals.missions.set(mission.summary.id, mission);
  return { manager, session, events, mission };
}

test('mid-task: crossing the trigger interrupts, compacts, then resumes invisibly with the nudge', async () => {
  const { manager, session, mission, events } = midTurnHarness();
  await manager.handle({ type: 'mission.send', missionId: 'app-mid', text: 'go' });
  // We interrupted the in-flight turn exactly once and compacted at that boundary.
  assert.equal(session.interrupts, 1);
  assert.equal(session.compactions, 1);
  // The task resumes on its own with the hidden nudge (long-horizon continuation).
  await waitFor(() => session.prompts.includes(RESUME_NUDGE));
  assert.deepEqual(session.prompts, ['go', RESUME_NUDGE]);
  assert.equal(mission.autoContinueCount, 1);
  // The interruption/compaction never surfaces as a turn failure.
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
});

test('mid-task: a no-op compaction still resumes the interrupted turn and latches saturation', async () => {
  const { manager, session, mission } = midTurnHarness();
  session.compactBehavior = 'noop';
  await manager.handle({ type: 'mission.send', missionId: 'app-mid', text: 'go' });
  // We interrupted the in-flight turn and asked the daemon to compact; it found
  // nothing to compact, but the aborted turn must not be left to stall.
  assert.equal(session.interrupts, 1);
  assert.equal(session.compactions, 1);
  await waitFor(() => session.prompts.includes(RESUME_NUDGE));
  assert.deepEqual(session.prompts, ['go', RESUME_NUDGE]);
  assert.equal(mission.autoContinueCount, 1);
  // A no-op latches the saturation guard so the resume runs to completion rather
  // than re-interrupting into another no-op compaction.
  assert.equal(mission.compactionSaturated, true);
});

test('mid-task: a transient compaction failure still resumes the interrupted turn', async () => {
  const { manager, session, mission } = midTurnHarness();
  session.compactBehavior = 'failed';
  await manager.handle({ type: 'mission.send', missionId: 'app-mid', text: 'go' });
  assert.equal(session.interrupts, 1);
  assert.equal(session.compactions, 1);
  // The session is still usable after a transient failure, so the aborted turn
  // resumes instead of stalling.
  await waitFor(() => session.prompts.includes(RESUME_NUDGE));
  assert.deepEqual(session.prompts, ['go', RESUME_NUDGE]);
  assert.equal(mission.autoContinueCount, 1);
  // A transient failure does NOT latch saturation; the next over-trigger turn
  // may try to compact again.
  assert.notEqual(mission.compactionSaturated, true);
});

// Drives a worker session directly through the mid-task interrupt path (not the
// pre-turn send path), reusing the armed/interrupt FakeMidTurnSession so the
// worker counterpart of the orchestrator resume gate can be exercised.
function workerMidTurnHarness() {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeMidTurnSession('worker-mid');
  const agent = {
    session,
    missionId: 'app-wmid',
    role: 'worker' as const,
    streaming: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
    compacting: false,
    effectiveCompactionTokenLimit: 200_000,
    autoContinueCount: undefined as number | undefined,
    compactionSaturated: false as boolean | undefined,
  };
  const mission = {
    summary: testSummary('app-wmid', 'droid-wmid'),
    agents: new Map<string, typeof agent>([['worker-mid', agent]]),
    terminalAgents: new Set<string>(),
    knownSubagents: new Set<string>(['worker-mid']),
    completedSubagents: new Set<string>(),
    linkedSubagents: new Set<string>(['worker-mid']),
    subagentToolUseIds: new Map<string, string>(),
    subagentSettings: new Map(),
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
    contextSnapshots: Map<string, { used: number; limit?: number }>;
    driveAgent: (a: typeof agent, t: string) => Promise<void>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  internals.contextSnapshots.set('worker-mid', { used: 10_000, limit: 1_000_000 });
  session.onTurnStart = () => {
    internals.contextSnapshots.set('worker-mid', { used: 250_000, limit: 1_000_000 });
  };
  internals.missions.set('app-wmid', mission);
  return { session, agent, events, internals };
}

test('mid-task worker: a no-op compaction still resumes the interrupted turn and latches saturation', async () => {
  const { session, agent, internals } = workerMidTurnHarness();
  session.compactBehavior = 'noop';
  await internals.driveAgent(agent, 'go');
  // The worker turn was interrupted and compaction found nothing to compact, but
  // the aborted work must still resume rather than leaving the worker stalled.
  assert.equal(session.interrupts, 1);
  assert.equal(session.compactions, 1);
  await waitFor(() => session.prompts.includes(RESUME_NUDGE));
  assert.deepEqual(session.prompts, ['go', RESUME_NUDGE]);
  assert.equal(agent.autoContinueCount, 1);
  assert.equal(agent.compactionSaturated, true);
});

test('mid-task worker: a stale compaction swap re-delivers queued sends to the swapped session', async () => {
  const { session, agent, internals } = workerMidTurnHarness();
  // The daemon swaps this worker to a new backing id during the mid-task
  // compaction, but adopting it fails (loadSession throws), leaving agent.session
  // pointing at the dead id.
  session.swapTo = 'worker-mid-new';
  agent.pendingSends.push('queued-during');
  const redelivered: Array<{ sessionId: string; text: string }> = [];
  const ext = internals as unknown as {
    runtime: { loadSession: () => Promise<never> };
    sendAgent: (missionId: string, sessionId: string, text: string) => Promise<void>;
  };
  ext.runtime = {
    loadSession: async () => {
      throw new Error('adoption failed');
    },
  };
  ext.sendAgent = async (_missionId, sessionId, text) => {
    redelivered.push({ sessionId, text });
  };
  await internals.driveAgent(agent, 'go');
  assert.equal(session.interrupts, 1);
  assert.equal(session.compactions, 1);
  // The dead-id worker is torn down, but the prompt queued while it streamed
  // during the compaction window is re-delivered to the persisted (compacted)
  // session id rather than silently dropped.
  assert.deepEqual(redelivered, [{ sessionId: 'worker-mid-new', text: 'queued-during' }]);
});

test('sendAgentNow clears the worker compaction saturation latch on a real steer', async () => {
  const { manager, mission } = workerAutoCompactHarness(150_000, 200_000);
  const agent = mission.agents.get('worker-compact') as {
    compactionSaturated?: boolean;
    compacting?: boolean;
    pendingSends: string[];
  };
  // Latched after a no-op compaction; a real steer is a fresh chance to compact
  // usefully. Mark it compacting so sendNow queues (never interrupts a
  // compaction) yet still clears the latch before returning.
  agent.compactionSaturated = true;
  agent.compacting = true;
  await manager.handle({
    type: 'agent.sendNow',
    missionId: 'app-compact',
    agentSessionId: 'worker-compact',
    text: 'steer',
  });
  assert.equal(agent.compactionSaturated, false);
  assert.equal(agent.pendingSends.includes('steer'), true);
});

// A turn that crosses the trigger WHILE a tool is in flight. The interrupt must
// wait for the tool's result (the safe boundary) and never fire mid-tool, so a
// file write / shell command is never cancelled underneath the model.
class FakeToolBoundarySession {
  prompts: string[] = [];
  interrupts = 0;
  compactions = 0;
  armed = true;
  interrupted = false;
  // Flips true the moment the tool_result is emitted; interrupt() snapshots it
  // so the test can prove the interrupt landed at/after the result, not mid-tool.
  resultEmitted = false;
  interruptedAfterResult = false;
  onTurnStart?: () => void;
  private release?: () => void;

  constructor(readonly sessionId: string) {}

  async *stream(prompt: string): AsyncGenerator<Record<string, unknown>, void, undefined> {
    this.prompts.push(prompt);
    if (prompt === RESUME_NUDGE || !this.armed) return;
    this.armed = false;
    // Push usage over the trigger before any tool starts, so the only thing
    // holding the interrupt back is the in-flight tool, not the threshold.
    this.onTurnStart?.();
    yield { type: 'tool_call', toolUse: { id: 't1', name: 'edit_file' } };
    yield { type: 'tool_call_delta', toolUse: { id: 't1' } };
    // Still mid-tool and over the trigger: a correct client does NOT interrupt.
    yield { type: 'thinking_text_delta', text: 'working' };
    if (this.interrupted) throw new Error('interrupted mid-tool');
    // Tool finishes -> safe boundary. The interrupt is expected on/after this.
    this.resultEmitted = true;
    yield { type: 'tool_result', toolName: 'edit_file', toolUseId: 't1', content: 'ok' };
    if (!this.interrupted) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    throw new Error('interrupted');
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    this.interrupted = true;
    this.interruptedAfterResult = this.resultEmitted;
    this.release?.();
  }

  async updateSettings(): Promise<void> {}

  onNotification(): () => void {
    return () => {};
  }

  async getContextStats(): Promise<{
    used: number;
    remaining: number;
    limit: number;
    accuracy: 'exact';
    updatedAt: string;
  }> {
    return {
      used: 250_000,
      remaining: 750_000,
      limit: 1_000_000,
      accuracy: 'exact',
      updatedAt: new Date().toISOString(),
    };
  }

  async compactSession(): Promise<{ newSessionId: string; removedCount: number }> {
    this.compactions += 1;
    return { newSessionId: this.sessionId, removedCount: 4 };
  }

  async close(): Promise<void> {}
}

function toolBoundaryHarness() {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeToolBoundarySession('droid-tool');
  const mission = {
    summary: testSummary('app-tool', session.sessionId),
    session,
    streaming: false,
    pendingSends: [] as string[],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set<string>(),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set<string>(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    effectiveCompactionTokenLimit: 200_000,
    compacting: false,
    autoContinueCount: undefined as number | undefined,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
    contextSnapshots: Map<string, { used: number; limit?: number }>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  // Seed under the trigger so pre-turn compaction does NOT fire; onTurnStart
  // pushes it over the trigger synchronously while a tool is in flight.
  internals.contextSnapshots.set('app-tool', { used: 10_000, limit: 1_000_000 });
  session.onTurnStart = () => {
    internals.contextSnapshots.set('app-tool', { used: 250_000, limit: 1_000_000 });
  };
  internals.missions.set(mission.summary.id, mission);
  return { manager, session, events };
}

test('mid-task: an over-trigger turn waits for the in-flight tool result before interrupting (never mid-tool)', async () => {
  const { manager, session, events } = toolBoundaryHarness();
  await manager.handle({ type: 'mission.send', missionId: 'app-tool', text: 'go' });
  // Exactly one interrupt, and it landed at the safe boundary: the tool_result
  // was already emitted when interrupt() fired, so no tool was cancelled mid-run.
  assert.equal(session.interrupts, 1);
  assert.equal(session.interruptedAfterResult, true);
  // It compacted at that boundary and resumed the long-horizon task invisibly.
  assert.equal(session.compactions, 1);
  await waitFor(() => session.prompts.includes(RESUME_NUDGE));
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
});

test('mid-task: a user prompt queued during the compaction wins over the hidden continue', async () => {
  const { manager, session, mission } = midTurnHarness();
  // Queue a real user prompt before the turn is interrupted/compacted, mirroring
  // a user typing while we compact mid-task.
  mission.pendingSends.push('user steered');
  await manager.handle({ type: 'mission.send', missionId: 'app-mid', text: 'go' });
  await waitFor(() => session.prompts.includes('user steered'));
  // The queued user prompt drives the post-compaction turn; the hidden nudge is
  // never sent, and the counter resets because real user input was delivered.
  assert.equal(session.prompts.includes(RESUME_NUDGE), false);
  assert.equal(session.prompts.includes('user steered'), true);
  assert.equal(mission.autoContinueCount, 0);
});

// Unlike FakeMidTurnSession (which throws on interrupt), the real SDK reacts to
// interrupt() by cancelling in-flight tools (emitting "Tool execution cancelled
// by user" errors) and then closing the turn with a terminal `result`. That
// terminal would mark the turn finished (wasTerminal) and skip compaction, and
// the cancellation errors would leak to the UI. This fake reproduces that exact
// tail so the regression is covered.
class FakeCancelTerminalSession {
  prompts: string[] = [];
  interrupts = 0;
  compactions = 0;
  armed = true;
  interrupted = false;
  onTurnStart?: () => void;
  private release?: () => void;

  constructor(readonly sessionId: string) {}

  async *stream(prompt: string): AsyncGenerator<Record<string, unknown>, void, undefined> {
    this.prompts.push(prompt);
    if (prompt === RESUME_NUDGE || !this.armed) return;
    this.armed = false;
    this.onTurnStart?.();
    // Interrupt lands on this completed-step boundary; the cancellation tail
    // below (errors + a terminal result) must then be dropped, not surfaced.
    yield { type: 'tool_result', toolName: 'Read', toolUseId: 'r1', content: 'data' };
    if (!this.interrupted) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    // The SDK's reaction to interrupt(): cancellations, then a terminal result.
    yield { type: 'error', message: 'Tool execution cancelled by user' };
    yield {
      type: 'tool_result',
      toolName: 'Read',
      content: 'Tool execution cancelled by user',
      isError: true,
    };
    yield { type: 'result' };
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    this.interrupted = true;
    this.release?.();
  }

  async updateSettings(): Promise<void> {}

  onNotification(): () => void {
    return () => {};
  }

  async getContextStats(): Promise<{
    used: number;
    remaining: number;
    limit: number;
    accuracy: 'exact';
    updatedAt: string;
  }> {
    return {
      used: 250_000,
      remaining: 750_000,
      limit: 1_000_000,
      accuracy: 'exact',
      updatedAt: new Date().toISOString(),
    };
  }

  async compactSession(): Promise<{ newSessionId: string; removedCount: number }> {
    this.compactions += 1;
    return { newSessionId: this.sessionId, removedCount: 4 };
  }

  async close(): Promise<void> {}
}

function cancelTerminalHarness() {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeCancelTerminalSession('droid-cancel');
  const mission = {
    summary: testSummary('app-cancel', session.sessionId),
    session,
    streaming: false,
    pendingSends: [] as string[],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set<string>(),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set<string>(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    effectiveCompactionTokenLimit: 200_000,
    compacting: false,
    autoContinueCount: undefined as number | undefined,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
    contextSnapshots: Map<string, { used: number; limit?: number }>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  internals.contextSnapshots.set('app-cancel', { used: 10_000, limit: 1_000_000 });
  session.onTurnStart = () => {
    internals.contextSnapshots.set('app-cancel', { used: 250_000, limit: 1_000_000 });
  };
  internals.missions.set(mission.summary.id, mission);
  return { manager, session, events, mission };
}

test('mid-task: an interrupt that ends with cancellations and a terminal result still compacts and drops the noise', async () => {
  const { manager, session, events } = cancelTerminalHarness();
  await manager.handle({ type: 'mission.send', missionId: 'app-cancel', text: 'go' });
  assert.equal(session.interrupts, 1);
  // The interrupt's terminal result must NOT skip compaction (the bug).
  assert.equal(session.compactions, 1);
  // It resumes invisibly despite the terminal result that closed the cut-off turn.
  await waitFor(() => session.prompts.includes(RESUME_NUDGE));
  assert.deepEqual(session.prompts, ['go', RESUME_NUDGE]);
  // The cancelled-tool errors produced by our own interrupt never reach the UI.
  assert.equal(
    events.some((e) => JSON.stringify(e).includes('cancelled by user')),
    false,
  );
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
});

// A model/task whose compacted summary is itself near the window: getContextStats
// stays over the trigger after every compaction. Both the first turn and the
// resumed turn stream and cross the trigger, so without the saturation latch this
// loops forever (compact -> resume -> immediately compact again).
class FakeSaturatedSession {
  prompts: string[] = [];
  interrupts = 0;
  compactions = 0;
  armed = true;
  interrupted = false;
  onTurnStart?: () => void;
  private release?: () => void;

  constructor(readonly sessionId: string) {}

  async *stream(prompt: string): AsyncGenerator<Record<string, unknown>, void, undefined> {
    this.prompts.push(prompt);
    this.onTurnStart?.();
    // Completed-step boundary: the first turn is interrupted here; the resumed
    // turn reaches the same boundary but must NOT be interrupted (saturated).
    yield { type: 'tool_result', toolName: 'Read', toolUseId: 's1', content: 'data' };
    if (this.armed) {
      // The first turn is the long one: block until the compaction interrupt
      // lands, then abort the stream the way the SDK does.
      this.armed = false;
      if (!this.interrupted) {
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
      }
      throw new Error('interrupted');
    }
    // The resumed turn must NOT be interrupted again (saturated); let it finish.
    yield { type: 'result' };
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    this.interrupted = true;
    this.release?.();
  }

  async updateSettings(): Promise<void> {}

  onNotification(): () => void {
    return () => {};
  }

  async getContextStats(): Promise<{
    used: number;
    remaining: number;
    limit: number;
    accuracy: 'exact';
    updatedAt: string;
  }> {
    return {
      used: 250_000,
      remaining: 750_000,
      limit: 1_000_000,
      accuracy: 'exact',
      updatedAt: new Date().toISOString(),
    };
  }

  async compactSession(): Promise<{ newSessionId: string; removedCount: number }> {
    this.compactions += 1;
    return { newSessionId: this.sessionId, removedCount: 4 };
  }

  async close(): Promise<void> {}
}

function saturatedHarness() {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeSaturatedSession('droid-sat');
  const mission = {
    summary: testSummary('app-sat', session.sessionId),
    session,
    streaming: false,
    pendingSends: [] as string[],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set<string>(),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set<string>(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    effectiveCompactionTokenLimit: 200_000,
    compacting: false,
    autoContinueCount: undefined as number | undefined,
    compactionSaturated: undefined as boolean | undefined,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
    contextSnapshots: Map<string, { used: number; limit?: number }>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  internals.contextSnapshots.set('app-sat', { used: 10_000, limit: 1_000_000 });
  session.onTurnStart = () => {
    internals.contextSnapshots.set('app-sat', { used: 250_000, limit: 1_000_000 });
  };
  internals.missions.set(mission.summary.id, mission);
  return { manager, session, events, mission };
}

test('mid-task: a compaction that cannot get under the trigger latches and stops looping', async () => {
  const { manager, session, mission, events } = saturatedHarness();
  await manager.handle({ type: 'mission.send', missionId: 'app-sat', text: 'go' });
  // It resumes once after the single compaction...
  await waitFor(() => session.prompts.includes(RESUME_NUDGE));
  // ...and the resumed turn runs to completion without re-compacting.
  await waitFor(() => mission.streaming === false && session.prompts.length === 2);
  assert.equal(session.compactions, 1);
  assert.equal(session.interrupts, 1);
  assert.deepEqual(session.prompts, ['go', RESUME_NUDGE]);
  // The latch is set and the user is told why automatic compaction paused.
  assert.equal(mission.compactionSaturated, true);
  assert.equal(
    events.some((e) => JSON.stringify(e).includes('could not be reduced further')),
    true,
  );
});

function workerAutoCompactHarness(workerUsed: number, workerLimit?: number, swapTo?: string) {
  const {
    manager,
    session: orchestratorSession,
    events,
    mission,
  } = autoCompactHarness(0, undefined);
  const workerSession = new FakeCompactionSession('worker-compact', workerUsed, swapTo);
  // When the daemon swaps the backing id, the reload hook loads the replacement
  // session; wire the runtime so that load resolves to a usable fake.
  const swappedSession = swapTo ? new FakeCompactionSession(swapTo, 10_000) : undefined;
  if (swappedSession) {
    (
      manager as unknown as {
        runtime: { loadSession: (id: string, handlers: unknown) => Promise<FakeCompactionSession> };
      }
    ).runtime = {
      loadSession: async () => swappedSession,
    };
  }
  mission.knownSubagents.add('worker-compact');
  mission.agents.set('worker-compact', {
    session: workerSession,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: false,
    pendingSends: [],
    lastUsedAt: Date.now(),
    compacting: false,
    effectiveCompactionTokenLimit: workerLimit,
  });
  // The worker trigger reads contextSnapshots (kept fresh by the poller / a
  // post-turn refresh). Seed it so the idle pre-turn check sees the usage the
  // fake worker session reports via getContextStats.
  (manager as unknown as { contextSnapshots: Map<string, { used: number }> }).contextSnapshots.set(
    'worker-compact',
    { used: workerUsed },
  );
  return { manager, events, mission, workerSession, swappedSession, orchestratorSession };
}

test('worker auto-compacts its own session in place once context crosses the worker limit', async () => {
  const { manager, events, workerSession, orchestratorSession } = workerAutoCompactHarness(
    250_000,
    200_000,
  );
  await manager.handle({
    type: 'agent.send',
    missionId: 'app-compact',
    agentSessionId: 'worker-compact',
    text: 'go',
  });
  assert.equal(workerSession.compactions, 1);
  // Boundary: worker compaction never touches the orchestrator's own session.
  assert.equal(orchestratorSession.compactions, 0);
  // Compaction status routes to the worker's own transcript, not the orchestrator chat.
  const status = events.find(
    (e) =>
      e.type === 'mission.transcript' &&
      (e as { event?: { kind?: string; text?: string } }).event?.kind === 'status' &&
      /Compacting conversation/i.test((e as { event?: { text?: string } }).event?.text ?? ''),
  ) as { event?: { agentSessionId?: string; role?: string } } | undefined;
  assert.equal(status?.event?.agentSessionId, 'worker-compact');
  assert.equal(status?.event?.role, 'worker');
  assert.equal(
    events.some((e) => e.type === 'mission.error' || e.type === 'error'),
    false,
  );
});

test('worker does not auto-compact while under its limit', async () => {
  const { manager, workerSession } = workerAutoCompactHarness(150_000, 200_000);
  await manager.handle({
    type: 'agent.send',
    missionId: 'app-compact',
    agentSessionId: 'worker-compact',
    text: 'go',
  });
  assert.equal(workerSession.compactions, 0);
});

test('worker does not auto-compact when its effective limit is unset', async () => {
  const { manager, workerSession } = workerAutoCompactHarness(250_000, undefined);
  await manager.handle({
    type: 'agent.send',
    missionId: 'app-compact',
    agentSessionId: 'worker-compact',
    text: 'go',
  });
  assert.equal(workerSession.compactions, 0);
});

test('worker compaction adopts a swapped backing session in place and re-keys it', async () => {
  const { manager, events, mission } = workerAutoCompactHarness(250_000, 200_000, 'worker-swapped');
  await manager.handle({
    type: 'agent.send',
    missionId: 'app-compact',
    agentSessionId: 'worker-compact',
    text: 'go',
  });
  // The worker is adopted under the daemon's new backing id and stays usable.
  assert.equal(mission.agents.has('worker-compact'), false);
  assert.equal(mission.agents.has('worker-swapped'), true);
  assert.ok(
    mission.knownSubagents.has('worker-swapped') && !mission.knownSubagents.has('worker-compact'),
  );
  // Clients are told to remap state from the old id to the new one.
  assert.equal(
    events.some(
      (e) =>
        e.type === 'mission.worker.rekey' &&
        (e as { oldSessionId?: string }).oldSessionId === 'worker-compact' &&
        (e as { newSessionId?: string }).newSessionId === 'worker-swapped',
    ),
    true,
  );
  // It completes normally (not stale/error).
  assert.equal(
    events.some(
      (e) =>
        e.type === 'mission.transcript' &&
        /Compaction complete/i.test((e as { event?: { text?: string } }).event?.text ?? ''),
    ),
    true,
  );
  assert.equal(
    events.some((e) => e.type === 'error' || e.type === 'mission.error'),
    false,
  );
});

test('worker swap re-keys and drains queued sends to the new backing session', async () => {
  const { manager, events, mission, swappedSession } = workerAutoCompactHarness(
    250_000,
    200_000,
    'worker-swapped',
  );
  const agent = mission.agents.get('worker-compact') as { pendingSends: string[] };
  agent.pendingSends.push('queued-during-compaction');
  await manager.handle({
    type: 'agent.send',
    missionId: 'app-compact',
    agentSessionId: 'worker-compact',
    text: 'go',
  });
  // The worker is re-keyed; the queued send is delivered to the new session
  // rather than dropped or surfaced as an error to resend.
  assert.equal(mission.agents.has('worker-swapped'), true);
  await waitFor(() => swappedSession?.prompts.includes('queued-during-compaction') ?? false);
  assert.equal(swappedSession?.prompts.includes('queued-during-compaction'), true);
  assert.equal(
    events.some(
      (e) => e.type === 'error' && /resent/i.test((e as { message?: string }).message ?? ''),
    ),
    false,
  );
});

test('transient worker compaction failure keeps the session and drains queued sends', async () => {
  const { manager, mission, workerSession } = workerAutoCompactHarness(250_000, 200_000);
  workerSession.failCompaction = true;
  const agent = mission.agents.get('worker-compact') as { pendingSends: string[] };
  agent.pendingSends.push('queued-after');
  await manager.handle({
    type: 'agent.send',
    missionId: 'app-compact',
    agentSessionId: 'worker-compact',
    text: 'go',
  });
  // A transient failure must not close the worker...
  assert.equal(mission.agents.has('worker-compact'), true);
  // ...and must not drop the queued send (it drains on a fresh turn).
  await waitFor(() => workerSession.prompts.includes('queued-after'));
  assert.equal(workerSession.prompts.includes('queued-after'), true);
});

test('worker swap whose reload fails goes stale: closes the worker and never drains into a dead session', async () => {
  const { manager, events, mission, workerSession, swappedSession } = workerAutoCompactHarness(
    250_000,
    200_000,
    'worker-swapped',
  );
  // The daemon swapped the backing id, but adopting the replacement fails
  // (loadSession rejects), so the old id is dead and the new one never loaded.
  (manager as unknown as { runtime: { loadSession: () => Promise<never> } }).runtime = {
    loadSession: async () => {
      throw new Error('cannot load swapped session');
    },
  };
  const agent = mission.agents.get('worker-compact') as { pendingSends: string[] };
  agent.pendingSends.push('queued-into-dead');
  await manager.handle({
    type: 'agent.send',
    missionId: 'app-compact',
    agentSessionId: 'worker-compact',
    text: 'go',
  });
  // The worker is torn down (no live agent under the old or swapped id)...
  assert.equal(mission.agents.has('worker-compact'), false);
  assert.equal(mission.agents.has('worker-swapped'), false);
  // ...but the new backing id is preserved: a rekey old->new is advertised so
  // clients remap the worker to the live (compacted) id and re-opens target it
  // rather than the dead old id...
  assert.equal(
    events.some(
      (e) =>
        e.type === 'mission.worker.rekey' &&
        (e as { oldSessionId?: string }).oldSessionId === 'worker-compact' &&
        (e as { newSessionId?: string }).newSessionId === 'worker-swapped',
    ),
    true,
  );
  // ...a recoverable error tells the user to re-open (mission not failed)...
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
  assert.equal(
    events.some(
      (e) =>
        e.type === 'error' &&
        /could not be adopted|re-open/i.test((e as { message?: string }).message ?? ''),
    ),
    true,
  );
  // ...and the queued send is never delivered to the stale old or unloaded new session.
  assert.equal(workerSession.prompts.includes('queued-into-dead'), false);
  assert.equal(swappedSession?.prompts.includes('queued-into-dead') ?? false, false);
});

test('worker swap whose reload keeps failing persists the new id to the spawn link and features', async () => {
  const { manager, events, mission } = workerAutoCompactHarness(250_000, 200_000, 'worker-swapped');
  // The new backing id can never be loaded, so adoption (and the retry) fail.
  (manager as unknown as { runtime: { loadSession: () => Promise<never> } }).runtime = {
    loadSession: async () => {
      throw new Error('cannot load swapped session');
    },
  };
  // Give the worker a persisted spawn link and a feature pinned to its id.
  mission.subagentToolUseIds.set('tool-w', 'worker-compact');
  mission.summary.features = [
    {
      id: 'f1',
      description: '',
      status: 'in_progress',
      skillName: 'builder',
      preconditions: [],
      expectedBehavior: [],
      verificationSteps: [],
      workerSessionIds: ['worker-compact'],
      currentWorkerSessionId: 'worker-compact',
      completedWorkerSessionId: null,
    },
  ];
  const recorded: Array<{ toolUseId: string; workerSessionId: string }> = [];
  (
    manager as unknown as {
      history: {
        recordEvent: () => void;
        syncSummaries: () => void;
        subagentLinks: () => WorkerHistoryLink[];
        recordSubagentLink: (m: string, t: string, w: string) => void;
      };
    }
  ).history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    subagentLinks: () => [
      { workerSessionId: 'worker-compact', toolUseId: 'tool-w', label: 'Builder' },
    ],
    recordSubagentLink: (_m, t, w) => recorded.push({ toolUseId: t, workerSessionId: w }),
  };

  await manager.handle({
    type: 'agent.send',
    missionId: 'app-compact',
    agentSessionId: 'worker-compact',
    text: 'go',
  });

  // The durable spawn link is re-pointed at the live (compacted) id...
  assert.deepEqual(recorded, [{ toolUseId: 'tool-w', workerSessionId: 'worker-swapped' }]);
  assert.equal(mission.subagentToolUseIds.get('tool-w'), 'worker-swapped');
  // ...and the feature pins move to the new id so feature-focused re-opens work.
  assert.deepEqual(mission.summary.features?.[0].workerSessionIds, ['worker-swapped']);
  assert.equal(mission.summary.features?.[0].currentWorkerSessionId, 'worker-swapped');
  // The worker is still torn down (its in-memory session is dead).
  assert.equal(mission.agents.has('worker-compact'), false);
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
});

test('rekeyAgentSession remaps worker ids inside mission summary features', async () => {
  const manager = new MissionManager(() => {});
  const oldSession = new FakeAgentSession('worker-old');
  const newSession = new FakeAgentSession('worker-new');
  const agent = {
    session: oldSession,
    missionId: 'app-feat',
    role: 'worker' as const,
    streaming: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
    unsubscribe: () => {},
  };
  const feature = (id: string, over: Partial<BridgeFeature>): BridgeFeature => ({
    id,
    description: '',
    status: 'in_progress',
    skillName: 'builder',
    preconditions: [],
    expectedBehavior: [],
    verificationSteps: [],
    ...over,
  });
  const summary = testSummary('app-feat', 'droid-feat');
  summary.features = [
    feature('f1', {
      workerSessionIds: ['worker-old', 'worker-other'],
      currentWorkerSessionId: 'worker-old',
      completedWorkerSessionId: null,
    }),
    feature('f2', {
      status: 'completed',
      workerSessionIds: ['worker-other'],
      currentWorkerSessionId: null,
      completedWorkerSessionId: 'worker-old',
    }),
    feature('f3', {
      status: 'pending',
      workerSessionIds: ['worker-other'],
      currentWorkerSessionId: null,
      completedWorkerSessionId: null,
    }),
  ];
  const mission = {
    summary,
    agents: new Map<string, typeof agent>([['worker-old', agent]]),
    knownSubagents: new Set(['worker-old']),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set<string>(),
    subagentToolUseIds: new Map<string, string>(),
    subagentSettings: new Map<string, { modelId?: string }>(),
  };
  const internals = manager as unknown as {
    runtime: { loadSession: () => Promise<FakeAgentSession> };
    history: { subagentLinks: () => WorkerHistoryLink[]; recordSubagentLink: () => void };
    contextSnapshots: Map<string, unknown>;
    missions: Map<string, typeof mission>;
    compaction: { rekeyAgentSession: (a: typeof agent, newId: string) => Promise<void> };
  };
  internals.runtime = { loadSession: async () => newSession };
  internals.history = { subagentLinks: () => [], recordSubagentLink: () => {} };
  internals.missions.set('app-feat', mission);

  await internals.compaction.rekeyAgentSession(agent, 'worker-new');

  const [f1, f2, f3] = mission.summary.features;
  // Old worker id is rewritten everywhere it is pinned (focus + numbering)...
  assert.deepEqual(f1.workerSessionIds, ['worker-new', 'worker-other']);
  assert.equal(f1.currentWorkerSessionId, 'worker-new');
  assert.deepEqual(f2.workerSessionIds, ['worker-other']);
  assert.equal(f2.completedWorkerSessionId, 'worker-new');
  // ...while unrelated ids and untouched features are preserved as-is.
  assert.deepEqual(f3.workerSessionIds, ['worker-other']);
  assert.equal(f3.currentWorkerSessionId, null);
});

function orchestratorSwapHarness(used: number, limit: number, swapTo: string) {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeCompactionSession('droid-old', used, swapTo);
  const mission = {
    summary: testSummary('app-swap', session.sessionId),
    session,
    streaming: false,
    pendingSends: [] as string[],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set<string>(),
    completedSubagents: new Set<string>(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set<string>(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    mcpConfigs: [],
    effectiveCompactionTokenLimit: limit,
    compacting: false,
    todoDisabledForDesign: undefined as boolean | undefined,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
    runtime: { loadSession: (id: string, handlers: unknown) => Promise<FakeCompactionSession> };
    contextSnapshots: Map<string, { used: number; limit?: number }>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  // The idle pre-turn trigger reads the getContextStats snapshot; seed it to the
  // usage the fake reports so the over-trigger send compacts before driving.
  mission.summary.contextTokens = used;
  internals.contextSnapshots.set('app-swap', { used });
  internals.missions.set(mission.summary.id, mission);
  return { manager, session, events, mission, internals };
}

test('orchestrator compaction swap recovers when the first reload fails but a retry succeeds', async () => {
  const { manager, session, events, mission, internals } = orchestratorSwapHarness(
    250_000,
    200_000,
    'droid-new',
  );
  const swapped = new FakeCompactionSession('droid-new', 10_000);
  let loadCalls = 0;
  internals.runtime = {
    loadSession: async () => {
      loadCalls += 1;
      if (loadCalls === 1) throw new Error('transient load failure');
      return swapped;
    },
  };
  mission.pendingSends.push('queued');
  await manager.handle({ type: 'mission.send', missionId: 'app-swap', text: 'go' });
  // Adopted on retry: the live session is the new backing id, persisted on the summary.
  assert.equal(mission.session.sessionId, 'droid-new');
  assert.equal(mission.summary.sessionId, 'droid-new');
  assert.equal(loadCalls, 2);
  // The mission stays live (not dropped) and the queued send drains to the new session.
  assert.equal(internals.missions.has('app-swap'), true);
  await waitFor(() => swapped.prompts.includes('queued'));
  assert.equal(swapped.prompts.includes('queued'), true);
  // The old (swapped-away) session never receives the queued send.
  assert.equal(session.prompts.includes('queued'), false);
  // Recovered transiently: the mission is not marked failed.
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
});

test('compaction swap re-applies the session model so it does not revert to the CLI default', async () => {
  const { manager, mission, internals } = orchestratorSwapHarness(250_000, 200_000, 'droid-new');
  // The user picked a specific model + reasoning for this session.
  mission.summary.modelId = 'custom:glm-5.2';
  mission.summary.reasoningEffort = 'high';
  const swapped = new FakeCompactionSession('droid-new', 10_000);
  internals.runtime = { loadSession: async () => swapped };
  await manager.handle({ type: 'mission.send', missionId: 'app-swap', text: 'go' });
  // The compacted session adopted the new backing id...
  assert.equal(mission.session.sessionId, 'droid-new');
  // ...and the selected model was re-applied to it (loadSession cannot carry the
  // model, so without this it would silently revert to the daemon default).
  const applied = swapped.settingsUpdates.find((u) => 'modelId' in u);
  assert.ok(applied, 'expected updateSettings to re-apply the model after the swap');
  assert.equal(applied?.modelId, 'custom:glm-5.2');
  assert.equal(applied?.reasoningEffort, 'high');
});

test('orchestrator compaction swap that never reloads drops the mission and re-delivers queued sends through resume', async () => {
  const { manager, session, events, mission, internals } = orchestratorSwapHarness(
    250_000,
    200_000,
    'droid-new',
  );
  internals.runtime = {
    loadSession: async () => {
      throw new Error('permanent load failure');
    },
  };
  let closedId: string | undefined;
  // Stub the disk-backed teardown; assert the mission is dropped for re-resume.
  (manager as unknown as { closeMission: (id: string) => Promise<void> }).closeMission = async (
    id: string,
  ) => {
    closedId = id;
    internals.missions.delete(id);
  };
  // Simulate a successful lazy resume: re-register a live mission on the new id.
  const resumed = new FakeCompactionSession('droid-new', 10_000);
  let resumeCalls = 0;
  (manager as unknown as { resumeMission: (id: string) => Promise<void> }).resumeMission = async (
    id: string,
  ) => {
    resumeCalls += 1;
    internals.missions.set(id, {
      ...mission,
      session: resumed,
      streaming: false,
      compacting: false,
      pendingSends: [],
    });
  };
  mission.pendingSends.push('queued-after-recovery');
  await manager.handle({ type: 'mission.send', missionId: 'app-swap', text: 'go' });
  // The daemon's new backing id is persisted so a later send re-resumes the live session...
  assert.equal(mission.summary.sessionId, 'droid-new');
  // ...the live mission is dropped (the next send re-resumes it)...
  assert.equal(closedId, 'app-swap');
  // ...a recoverable error is surfaced without marking the mission failed...
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
  assert.equal(
    events.some(
      (e) =>
        e.type === 'error' &&
        /reloading it failed/i.test((e as { message?: string }).message ?? ''),
    ),
    true,
  );
  // ...the queued send is NOT discarded: it re-resumes and drives the new session...
  await waitFor(() => resumed.prompts.includes('queued-after-recovery'));
  assert.equal(resumeCalls >= 1, true);
  // ...and neither prompt streamed into the dead old session. Pre-turn compaction
  // parks the triggering prompt, so a stale swap re-delivers both the queued send
  // and the triggering prompt to the resumed (live) session, never the dead one.
  assert.equal(session.prompts.includes('queued-after-recovery'), false);
  assert.equal(session.prompts.includes('go'), false);
  await waitFor(() => resumed.prompts.includes('go'));
  assert.equal(resumed.prompts.includes('go'), true);
});

test('manual compaction swap that never reloads re-delivers sends queued during compaction', async () => {
  const { manager, session, events, mission, internals } = orchestratorSwapHarness(
    10_000,
    200_000,
    'droid-new',
  );
  internals.runtime = {
    loadSession: async () => {
      throw new Error('permanent load failure');
    },
  };
  let closedId: string | undefined;
  (manager as unknown as { closeMission: (id: string) => Promise<void> }).closeMission = async (
    id: string,
  ) => {
    closedId = id;
    internals.missions.delete(id);
  };
  const resumed = new FakeCompactionSession('droid-new', 10_000);
  let resumeCalls = 0;
  (manager as unknown as { resumeMission: (id: string) => Promise<void> }).resumeMission = async (
    id: string,
  ) => {
    resumeCalls += 1;
    internals.missions.set(id, {
      ...mission,
      session: resumed,
      streaming: false,
      compacting: false,
      pendingSends: [],
    });
  };
  // A prompt queued while the manual compaction was running.
  mission.pendingSends.push('queued-during-manual');
  await manager.handle({ type: 'mission.compact', missionId: 'app-swap' });
  // The live mission is dropped and the new backing id is persisted...
  assert.equal(closedId, 'app-swap');
  assert.equal(mission.summary.sessionId, 'droid-new');
  // ...the queued prompt is re-delivered through resume (not discarded)...
  await waitFor(() => resumed.prompts.includes('queued-during-manual'));
  assert.equal(resumeCalls >= 1, true);
  // ...without ever streaming into the dead old session, and not marked failed.
  assert.equal(session.prompts.includes('queued-during-manual'), false);
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
});

test('orchestrator stale-swap recovery reports completed on retry success so the turn resumes', async () => {
  const { manager, mission, internals } = orchestratorSwapHarness(250_000, 200_000, 'droid-new');
  // recoverStaleMissionSwap IS the retry after the in-band adoption failed, so
  // here the reload succeeds and the swap is adopted in place.
  const swapped = new FakeCompactionSession('droid-new', 10_000);
  internals.runtime = { loadSession: async () => swapped };
  const outcome = await (
    manager as unknown as {
      compaction: {
        recoverStaleMissionSwap: (
          m: typeof mission,
          id: string,
          c: { tokensIn: number; tokensOut: number },
        ) => Promise<string>;
      };
    }
  ).compaction.recoverStaleMissionSwap(mission, 'droid-new', { tokensIn: 0, tokensOut: 0 });
  // Adopting the swap on retry leaves the mission live on the compacted session,
  // so it must report 'completed'. Returning 'stale' (the old behavior) skipped
  // the auto-resume in drive()'s finally and silently stalled the turn.
  assert.equal(outcome, 'completed');
  assert.equal(mission.session.sessionId, 'droid-new');
  assert.equal(internals.missions.has('app-swap'), true);
});

test('orchestrator stale-swap recovery reports stale and drops the mission when it never reloads', async () => {
  const { manager, mission, internals } = orchestratorSwapHarness(250_000, 200_000, 'droid-new');
  internals.runtime = {
    loadSession: async () => {
      throw new Error('permanent load failure');
    },
  };
  let closedId: string | undefined;
  (manager as unknown as { closeMission: (id: string) => Promise<void> }).closeMission = async (
    id: string,
  ) => {
    closedId = id;
    internals.missions.delete(id);
  };
  const outcome = await (
    manager as unknown as {
      compaction: {
        recoverStaleMissionSwap: (
          m: typeof mission,
          id: string,
          c: { tokensIn: number; tokensOut: number },
        ) => Promise<string>;
      };
    }
  ).compaction.recoverStaleMissionSwap(mission, 'droid-new', { tokensIn: 0, tokensOut: 0 });
  // Only after the mission is torn down does it report 'stale' (the next send
  // re-resumes against the persisted compacted id).
  assert.equal(outcome, 'stale');
  assert.equal(closedId, 'app-swap');
  assert.equal(mission.summary.sessionId, 'droid-new');
});

test('compaction swap re-applies the session autonomy so it does not revert to the daemon default', async () => {
  const { manager, mission, internals } = orchestratorSwapHarness(250_000, 200_000, 'droid-new');
  // The user runs this mission at high autonomy.
  mission.summary.autonomy = 'high';
  const swapped = new FakeCompactionSession('droid-new', 10_000);
  internals.runtime = { loadSession: async () => swapped };
  await manager.handle({ type: 'mission.send', missionId: 'app-swap', text: 'go' });
  assert.equal(mission.session.sessionId, 'droid-new');
  // loadSession cannot carry autonomy, so without re-applying it the compacted
  // session would silently fall back to the daemon-default autonomy.
  const applied = swapped.settingsUpdates.find((u) => 'autonomyLevel' in u);
  assert.ok(applied, 'expected updateSettings to re-apply autonomy after the swap');
  assert.equal(applied?.autonomyLevel, 'high');
});

test('orchestrator stale-swap recovery success latches saturation when still over the trigger', async () => {
  const { manager, mission, internals } = orchestratorSwapHarness(250_000, 200_000, 'droid-new');
  // The in-band adoption fails (load 1 throws) but recoverStaleMissionSwap's
  // retry adopts a compacted session that still reports over-trigger usage.
  const swapped = new FakeCompactionSession('droid-new', 250_000);
  let loadCalls = 0;
  internals.runtime = {
    loadSession: async () => {
      loadCalls += 1;
      if (loadCalls === 1) throw new Error('transient load failure');
      return swapped;
    },
  };
  const outcome = await (
    manager as unknown as {
      compaction: {
        compactMission: (m: typeof mission, ci: string | undefined, t: string) => Promise<string>;
      };
    }
  ).compaction.compactMission(mission, undefined, 'auto');
  assert.equal(outcome, 'completed');
  assert.equal(loadCalls, 2);
  // A retry that adopts the swap in place is a real completed compaction, so the
  // saturation latch is set just like the normal completed path; the old early
  // return skipped it and left the next turn to trigger one redundant compaction.
  assert.equal((mission as { compactionSaturated?: boolean }).compactionSaturated, true);
});

test('worker stale-swap recovery success latches saturation when still over the trigger', async () => {
  const { manager, mission } = workerAutoCompactHarness(250_000, 200_000, 'worker-new');
  const agent = mission.agents.get('worker-compact')!;
  // recoverStaleAgentSwap is the retry after the in-band rekey failed: throw
  // once, then adopt a compacted session that still reports over-trigger usage.
  const swapped = new FakeCompactionSession('worker-new', 250_000);
  let loadCalls = 0;
  (
    manager as unknown as {
      runtime: { loadSession: (id: string, h: unknown) => Promise<FakeCompactionSession> };
    }
  ).runtime = {
    loadSession: async () => {
      loadCalls += 1;
      if (loadCalls === 1) throw new Error('transient load failure');
      return swapped;
    },
  };
  const outcome = await (
    manager as unknown as {
      compaction: { compactAgent: (a: typeof agent, t: string) => Promise<string> };
    }
  ).compaction.compactAgent(agent, 'auto');
  assert.equal(outcome, 'completed');
  assert.equal(loadCalls, 2);
  // Mirrors the orchestrator: a recovered-completed worker compaction latches
  // saturation rather than leaving the worker to re-compact on its next turn.
  assert.equal((agent as { compactionSaturated?: boolean }).compactionSaturated, true);
});

// ── #30/#17: opening a worker always settles its loading state ──

test('#30/#17 opening a worker on a non-live mission settles loading with an honest open', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  // No mission is registered, so openAgent cannot resume one. It must still ack
  // 'opened' (honest empty) so the worker card stops loading forever instead of
  // hanging on the optimistic loading flag the client set before subscribing.
  await manager.handle({
    type: 'mission.subscribeWorker',
    missionId: 'ghost-mission',
    workerSessionId: 'w1',
  });
  assert.ok(
    events.some(
      (e) =>
        e.type === 'agent.updated' &&
        (e as { agentSessionId?: string }).agentSessionId === 'w1' &&
        (e as { status?: string }).status === 'opened',
    ),
  );
});

// ── #19: a turn ends at its first terminal result; later generation is dropped ──

// Yields a scripted list of raw SDK stream events per turn so a full drive()
// can exercise the terminal-enforcement path.
class FakeScriptedSession {
  prompts: string[] = [];
  constructor(
    readonly sessionId: string,
    private readonly turns: Record<string, unknown>[][],
  ) {}
  async *stream(prompt: string): AsyncGenerator<Record<string, unknown>, void, undefined> {
    this.prompts.push(prompt);
    for (const ev of this.turns.shift() ?? []) yield ev;
  }
  async updateSettings(): Promise<void> {}
  async getContextStats(): Promise<{
    used: number;
    remaining: number;
    limit: number;
    accuracy: 'exact';
    updatedAt: string;
  }> {
    return {
      used: 0,
      remaining: 100_000,
      limit: 100_000,
      accuracy: 'exact',
      updatedAt: new Date().toISOString(),
    };
  }
}

function terminalHarness(turns: Record<string, unknown>[][]) {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeScriptedSession('droid-term', turns);
  const mission = {
    summary: testSummary('app-term', session.sessionId),
    session,
    streaming: false,
    pendingSends: [] as string[],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set(),
    completedSubagents: new Set(),
    terminalAgents: new Set<string>(),
    linkedSubagents: new Set(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    compacting: false,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
    applyEvent: (
      missionId: string,
      agentSessionId: string,
      role: string,
      ev: Record<string, unknown>,
    ) => void;
    applyNormalizedForAgent: (
      missionId: string,
      agentSessionId: string,
      n: { transcript?: Record<string, unknown>; done?: boolean; subagent?: unknown },
    ) => void;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  internals.missions.set(mission.summary.id, mission);
  const transcriptTexts = () =>
    events
      .filter((e) => e.type === 'mission.transcript')
      .map((e) => (e as { event: { text?: string } }).event.text);
  return { manager, events, mission, internals, session, transcriptTexts };
}

test('#19 a turn keeps its pre-terminal answer but drops generation after the result', async () => {
  const { manager, mission, transcriptTexts } = terminalHarness([
    [
      { type: 'assistant_text_delta', text: 'final answer' },
      { type: 'result' },
      { type: 'assistant_text_delta', text: 'leaked tail' },
      { type: 'tool_call', toolUse: { id: 'late', name: 'Grep', input: { pattern: 'x' } } },
    ],
    [{ type: 'assistant_text_delta', text: 'second turn answer' }],
  ]);

  await manager.handle({ type: 'mission.send', missionId: 'app-term', text: 'first' });
  await waitFor(() => mission.streaming === false && transcriptTexts().includes('final answer'));

  // The pre-terminal answer is kept; post-terminal generation is quarantined.
  assert.ok(transcriptTexts().includes('final answer'));
  assert.ok(!transcriptTexts().includes('leaked tail'));
  // The session is flagged terminal for this turn.
  assert.ok(mission.terminalAgents.has('app-term'));

  // The next turn resets the flag so its answer flows again.
  await manager.handle({ type: 'mission.send', missionId: 'app-term', text: 'second' });
  await waitFor(() => transcriptTexts().includes('second turn answer'));
  assert.ok(!mission.terminalAgents.has('app-term'));
});

test('#19 terminal enforcement is scoped per agent session', () => {
  const { mission, internals, transcriptTexts } = terminalHarness([]);
  // The orchestrator turn is terminal, but a worker on the same mission is not.
  mission.terminalAgents.add('app-term');
  internals.applyEvent('app-term', 'worker-1', 'worker', {
    type: 'assistant_text_delta',
    text: 'worker still talking',
  });
  internals.applyEvent('app-term', 'app-term', 'orchestrator', {
    type: 'assistant_text_delta',
    text: 'orchestrator blocked',
  });
  assert.ok(transcriptTexts().includes('worker still talking'));
  assert.ok(!transcriptTexts().includes('orchestrator blocked'));
});

test('#19 a failed result after the terminal result still surfaces', () => {
  const { internals, transcriptTexts } = terminalHarness([]);
  internals.applyEvent('app-term', 'app-term', 'orchestrator', { type: 'result' });
  // A failed tool result is not model "generation"; it must surface post-terminal.
  internals.applyEvent('app-term', 'app-term', 'orchestrator', {
    type: 'tool_result',
    toolName: 'Execute',
    content: 'boom',
    isError: true,
  });
  assert.ok(transcriptTexts().includes('boom'));
});

test('#19 a post-terminal subagent spawn keeps its worker signal, drops only the tool transcript', () => {
  const { events, internals } = terminalHarness([]);
  internals.applyEvent('app-term', 'app-term', 'orchestrator', { type: 'result' });
  internals.applyEvent('app-term', 'app-term', 'orchestrator', {
    type: 'tool_call',
    subagentSessionId: 'w1',
    toolUse: { id: 'tA', name: 'Task', input: { subagent_type: 'worker', prompt: 'go' } },
  });
  // The subagent side effect still flows (worker started)...
  assert.ok(
    events.some(
      (e) =>
        e.type === 'mission.worker' &&
        (e as { event?: string }).event === 'started' &&
        (e as { workerSessionId?: string }).workerSessionId === 'w1',
    ),
  );
  // ...but the orchestrator's own Task tool_call transcript is quarantined.
  assert.ok(
    !events.some(
      (e) =>
        e.type === 'mission.transcript' &&
        (e as { event?: { kind?: string; toolName?: string } }).event?.kind === 'tool_call' &&
        (e as { event?: { toolName?: string } }).event?.toolName === 'Task',
    ),
  );
});

test('#19 post-terminal generation is dropped on the shared agent entry (notification path)', () => {
  const { mission, internals, transcriptTexts } = terminalHarness([]);
  // Worker notifications now route through applyNormalizedForAgent, so a late
  // text delta for a terminal worker is quarantined here too, not just on the
  // stream loop.
  mission.terminalAgents.add('w1');
  internals.applyNormalizedForAgent('app-term', 'w1', {
    transcript: {
      id: 'late-1',
      missionId: 'app-term',
      agentSessionId: 'w1',
      role: 'worker',
      ts: 1,
      kind: 'text',
      text: 'late worker tail',
    },
  });
  assert.ok(!transcriptTexts().includes('late worker tail'));
});
