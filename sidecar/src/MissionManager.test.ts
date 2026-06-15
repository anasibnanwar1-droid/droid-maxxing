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
} from './compaction.js';
import type { MissionSummary, ModelInfo, ServerEvent, WorkerHistoryLink } from './protocol.js';

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

test('builds Droid compaction init payloads', () => {
  assert.deepEqual(
    createCompactionSettingsForModel('model-a', {
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'model-a': 150_000 },
    }),
    {
      compactionTokenLimit: 150_000,
      compactionThresholdCheckEnabled: true,
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
      compactionThresholdCheckEnabled: true,
    },
  );
});

test('disables daemon compaction threshold checks when no budget exists', () => {
  assert.deepEqual(
    createCompactionSettingsForModel(
      'model-a',
      { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
      {},
      100_000,
    ),
    { compactionThresholdCheckEnabled: false },
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

test('emits live daemon compaction disable payloads without a budget', () => {
  assert.deepEqual(
    createCompactionSettingsForModel('model-a', {
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: {},
    }),
    { compactionThresholdCheckEnabled: false },
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

test('live orchestrator model changes enable daemon compaction threshold checks', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeSession('droid-settings');
  const mission = {
    summary: {
      ...testSummary('app-settings', session.sessionId),
      modelId: 'model-a',
      maxContextTokens: 500_000,
    },
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set(),
    completedSubagents: new Set(),
    linkedSubagents: new Set(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    compacting: false,
  };
  const internals = manager as unknown as {
    getFactoryDefaults: () => Promise<{
      modelId?: string;
      compactionTokenLimit?: number;
      compactionTokenLimitPerModel?: Record<string, number>;
    }>;
    history: {
      syncSummaries: () => void;
      recordEvent: () => void;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
      summaryPatches: () => Map<string, Partial<MissionSummary>>;
      hiddenDroidSessionIds: () => Set<string>;
    };
    missions: Map<string, typeof mission>;
    cachedModels?: ModelInfo[];
  };
  internals.getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimit: 400_000,
    compactionTokenLimitPerModel: { 'model-b': 250_000 },
  });
  internals.cachedModels = [
    {
      id: 'model-b',
      displayName: 'Model B',
      isDefault: false,
      isCustom: false,
      supportedReasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      maxContextTokens: 300_000,
    },
  ];
  internals.history = {
    syncSummaries: () => {},
    recordEvent: () => {},
    recordSubagentLink: () => {},
    subagentLinks: () => [],
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
  };
  internals.missions.set(mission.summary.id, mission);

  await manager.handle({
    type: 'settings.agent.update',
    missionId: mission.summary.id,
    agent: 'orchestrator',
    modelId: 'model-b',
  });

  assert.deepEqual(session.settingsUpdates.at(-1), {
    modelId: 'model-b',
    compactionTokenLimit: 250_000,
    compactionThresholdCheckEnabled: true,
  });

  await manager.handle({
    type: 'settings.agent.update',
    missionId: mission.summary.id,
    agent: 'orchestrator',
    modelId: null,
  });

  assert.deepEqual(session.settingsUpdates.at(-1), {
    modelId: 'model-a',
    compactionTokenLimit: 400_000,
    compactionThresholdCheckEnabled: true,
  });

  await manager.handle({
    type: 'session.updateSettings',
    sessionId: mission.summary.id,
    modelId: null,
  });

  assert.deepEqual(session.settingsUpdates.at(-1), {
    modelId: 'model-a',
    compactionTokenLimit: 400_000,
    compactionThresholdCheckEnabled: true,
  });
  assert.equal(
    events.some((event) => event.type === 'mission.error' || event.type === 'error'),
    false,
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
  callOrder: string[] = [];
  compactions = 0;
  failCompaction = false;
  usedAfterStream?: number;
  streamEvents: Record<string, unknown>[] = [];
  usedBeforeStreamEvent?: number;
  limit = 1_000_000;
  accuracy: 'exact' | 'estimated' = 'exact';
  breakdown?: unknown;
  beforeContextStats?: () => Promise<void> | void;
  settingsUpdates: Array<Record<string, unknown>> = [];
  notificationHandler?: (note: Record<string, unknown>) => void;
  unsubscribed = false;

  constructor(
    readonly sessionId: string,
    private used: number,
    private swapTo?: string,
  ) {}

  async *stream(prompt: string): AsyncGenerator<Record<string, unknown>, void, undefined> {
    this.callOrder.push(`stream:${prompt}`);
    this.prompts.push(prompt);
    for (const event of this.streamEvents) {
      if (this.usedBeforeStreamEvent !== undefined) this.used = this.usedBeforeStreamEvent;
      yield event;
    }
    if (this.usedAfterStream !== undefined) this.used = this.usedAfterStream;
  }

  async updateSettings(params: Record<string, unknown>): Promise<void> {
    this.settingsUpdates.push(params);
  }

  onNotification(cb: (note: Record<string, unknown>) => void): () => void {
    this.notificationHandler = cb;
    return () => {
      if (this.notificationHandler === cb) this.notificationHandler = undefined;
      this.unsubscribed = true;
    };
  }

  emitNotification(note: Record<string, unknown>): void {
    this.notificationHandler?.(note);
  }

  async getContextStats(): Promise<{
    used: number;
    remaining: number;
    limit: number;
    accuracy: 'exact' | 'estimated';
    updatedAt: string;
  }> {
    await this.beforeContextStats?.();
    return {
      used: this.used,
      remaining: Math.max(0, this.limit - this.used),
      limit: this.limit,
      accuracy: this.accuracy,
      updatedAt: new Date().toISOString(),
    };
  }

  async getContextBreakdown(): Promise<unknown> {
    return this.breakdown;
  }

  async compactSession(): Promise<{ newSessionId: string; removedCount: number }> {
    this.callOrder.push('compact');
    if (this.failCompaction) throw new Error('transient compaction failure');
    this.compactions += 1;
    return { newSessionId: this.swapTo ?? this.sessionId, removedCount: 4 };
  }

  async close(): Promise<void> {}
}

function streamHarness(used: number) {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeCompactionSession('droid-stream', used);
  const mission = {
    summary: testSummary('app-stream', session.sessionId),
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map(),
    knownSubagents: new Set(),
    completedSubagents: new Set(),
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
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<string, typeof mission>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  internals.missions.set(mission.summary.id, mission);
  return { manager, session, events, mission };
}

test('routes daemon compacted notifications from orchestrator sessions', () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeCompactionSession('droid-notify', 10_000);
  const summary = testSummary('app-notify', session.sessionId);
  const internals = manager as unknown as {
    createLiveMission: (
      summary: MissionSummary,
      session: FakeCompactionSession,
      mcpServers?: [],
      mcpConfigs?: [],
    ) => { summary: MissionSummary; unsubscribe?: () => void };
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
    };
    missions: Map<string, { summary: MissionSummary; unsubscribe?: () => void }>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
  };
  const mission = internals.createLiveMission(summary, session);
  internals.missions.set(summary.id, mission);

  session.emitNotification({
    notification: {
      type: 'assistant_text_delta',
      messageId: 'msg-1',
      blockIndex: 0,
      textDelta: 'duplicate stream token',
    },
  });
  assert.equal(
    events.some((event) => event.type === 'mission.transcript'),
    false,
  );

  session.emitNotification({ notification: { type: 'session_compacted', removedCount: 7 } });

  const transcript = events.find(
    (event) =>
      event.type === 'mission.transcript' &&
      event.event.kind === 'status' &&
      event.event.text === 'Compaction complete. Removed 7 messages.',
  );
  assert.ok(transcript);
  assert.equal(session.unsubscribed, false);
  mission.unsubscribe?.();
  assert.equal(session.unsubscribed, true);
});

test('does not sidecar-compact before starting a streamed turn', async () => {
  const { manager, session, events } = streamHarness(250_000);
  await manager.handle({ type: 'mission.send', missionId: 'app-stream', text: 'hello' });
  assert.equal(session.compactions, 0);
  assert.deepEqual(session.callOrder, ['stream:hello']);
  assert.deepEqual(session.prompts, ['hello']);
  assert.equal(
    events.some((event) => event.type === 'mission.error' || event.type === 'error'),
    false,
  );
});

test('does not treat tool_result as a safe mid-task compaction checkpoint', async () => {
  const { manager, session } = streamHarness(150_000);
  session.usedBeforeStreamEvent = 250_000;
  session.streamEvents = [{ type: 'tool_result', toolName: 'Read', content: 'ok', isError: false }];

  await manager.handle({ type: 'mission.send', missionId: 'app-stream', text: 'hello' });

  assert.equal(session.compactions, 0);
  assert.deepEqual(session.prompts, ['hello']);
});

test('does not auto-compact after the final answer in the same visible turn', async () => {
  const { manager, session } = streamHarness(150_000);
  session.usedAfterStream = 250_000;
  await manager.handle({ type: 'mission.send', missionId: 'app-stream', text: 'hello' });
  assert.equal(session.compactions, 0);
  assert.deepEqual(session.prompts, ['hello']);
});

test('settles to paused when a mid-stream paused event was ignored', async () => {
  const { manager, session, mission } = streamHarness(100_000);
  mission.summary.kind = 'mission_orchestrator';
  session.streamEvents = [{ type: 'mission_state_changed', state: 'paused' }];

  await manager.handle({ type: 'mission.send', missionId: 'app-stream', text: 'hello' });

  assert.equal(mission.summary.streaming, false);
  assert.equal(mission.summary.phase, 'paused');
});

test('estimated context stats prefer detailed breakdown usage', async () => {
  const { manager, session, mission, events } = streamHarness(200_000);
  session.limit = 200_000;
  session.accuracy = 'estimated';
  session.breakdown = {
    contextBudget: 200_000,
    usedTokens: 154_982,
    freeTokens: 45_018,
    categories: [
      { name: 'System prompt', tokens: 2_082 },
      { name: 'System tools', tokens: 9_556 },
      { name: 'Messages', tokens: 134_827 },
    ],
  };

  await manager.handle({ type: 'mission.send', missionId: 'app-stream', text: 'hello' });

  assert.equal(mission.summary.contextTokens, 154_982);
  assert.equal(mission.summary.contextRemainingTokens, 45_018);
  const contextEvent = events.findLast((event) => event.type === 'context.updated') as
    | { type: 'context.updated'; stats: { used: number; remaining: number; limit: number } }
    | undefined;
  assert.equal(contextEvent?.stats.used, 154_982);
  assert.equal(contextEvent?.stats.remaining, 45_018);
  assert.equal(contextEvent?.stats.limit, 200_000);
});

test('Stop during compaction drops queued sends but does not interrupt the compaction', async () => {
  const { manager, session, mission } = streamHarness(0);
  mission.compacting = true;
  let interrupts = 0;
  (session as unknown as { interrupt: () => Promise<void> }).interrupt = async () => {
    interrupts += 1;
  };
  // A send during compaction queues instead of driving.
  await manager.handle({ type: 'mission.send', missionId: 'app-stream', text: 'queued' });
  assert.equal(mission.pendingSends.length, 1);
  // Stop must clear the queue but never interrupt the in-flight compaction.
  await manager.handle({ type: 'mission.interrupt', missionId: 'app-stream' });
  assert.equal(interrupts, 0);
  assert.equal(mission.pendingSends.length, 0);
});

test('rejects manual compaction while streaming', async () => {
  const { manager, mission, events } = streamHarness(250_000);
  mission.streaming = true;
  await manager.handle({
    type: 'mission.compact',
    missionId: 'app-stream',
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

function orchestratorSwapHarness(used: number, swapTo: string) {
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
    linkedSubagents: new Set<string>(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    mcpConfigs: [],
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
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
    recordSubagentLink: () => {},
    subagentLinks: () => [],
  };
  internals.missions.set(mission.summary.id, mission);
  return { manager, session, events, mission, internals };
}

test('manual compaction swap recovers when the first reload fails but a retry succeeds', async () => {
  const { manager, session, events, mission, internals } = orchestratorSwapHarness(
    250_000,
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
  await manager.handle({ type: 'mission.compact', missionId: 'app-swap' });
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

test('manual compaction swap reapplies default model per-model daemon settings', async () => {
  const { manager, mission, internals } = orchestratorSwapHarness(10_000, 'droid-new');
  const swapped = new FakeCompactionSession('droid-new', 10_000);
  mission.summary.modelId = undefined;
  const settingsInternals = internals as typeof internals & {
    cachedModels?: ModelInfo[];
    getFactoryDefaults: () => Promise<{
      modelId?: string;
      compactionTokenLimit?: number;
      compactionTokenLimitPerModel?: Record<string, number>;
    }>;
  };
  settingsInternals.cachedModels = [
    {
      id: 'default-model',
      displayName: 'Default Model',
      isDefault: true,
      isCustom: false,
      supportedReasoningEfforts: [],
      maxContextTokens: 200_000,
    },
  ];
  settingsInternals.getFactoryDefaults = async () => ({
    modelId: 'default-model',
    compactionTokenLimit: 400_000,
    compactionTokenLimitPerModel: { 'default-model': 150_000 },
  });
  internals.runtime = {
    loadSession: async () => swapped,
  };

  await manager.handle({ type: 'mission.compact', missionId: 'app-swap' });

  assert.deepEqual(swapped.settingsUpdates.at(-1), {
    compactionTokenLimit: 150_000,
    compactionThresholdCheckEnabled: true,
  });
});

test('manual compaction swap that never reloads re-delivers sends queued during compaction', async () => {
  const { manager, session, events, mission, internals } = orchestratorSwapHarness(
    10_000,
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
