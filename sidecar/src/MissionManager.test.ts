import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAutonomyForCommand,
  createMissionAgentDefaultsForMode,
  createModelDefaultsForMode,
  createSessionSettingsForAgent,
  defaultModelForAgent,
  MissionManager,
  modeForSummary,
  startupFactoryDefaults,
  validateFactoryDefaults,
} from './MissionManager.js';
import {
  compactionTokenLimitForModel,
  daemonCompactionSettings,
  readSessionCompacted,
  resumedCompactionTokenLimit,
} from './compaction.js';
import type {
  FactoryDefaultSettings,
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

test('daemon compaction settings prefer a per-model limit and keep the threshold check on', () => {
  assert.deepEqual(
    daemonCompactionSettings('model-a', {
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'model-a': 150_000 },
    }),
    {
      compactionThresholdCheckEnabled: true,
      compactionTokenLimit: 150_000,
    },
  );
});

test('daemon compaction settings omit the token limit when settings clear it', () => {
  assert.deepEqual(
    daemonCompactionSettings('model-a', {
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: {},
    }),
    { compactionThresholdCheckEnabled: true },
  );
});

test('compaction limit is capped to the model context window', () => {
  // A trigger above the window can never fire before the window fills, so it is
  // clamped down to the window.
  assert.equal(
    compactionTokenLimitForModel('model-a', { compactionTokenLimit: 500_000 }, {}, 190_000),
    190_000,
  );
  // A per-model override above the window is clamped too.
  assert.equal(
    compactionTokenLimitForModel(
      'model-a',
      { compactionTokenLimitPerModel: { 'model-a': 900_000 } },
      {},
      190_000,
    ),
    190_000,
  );
  // A limit at or below the window is left untouched.
  assert.equal(
    compactionTokenLimitForModel('model-a', { compactionTokenLimit: 120_000 }, {}, 190_000),
    120_000,
  );
});

test('daemon and resume settings clamp the token limit to the model window', () => {
  assert.deepEqual(
    daemonCompactionSettings('model-a', { compactionTokenLimit: 500_000 }, {}, 190_000),
    { compactionThresholdCheckEnabled: true, compactionTokenLimit: 190_000 },
  );
  assert.equal(
    resumedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimit: 500_000, compactionTokenLimitPerModel: undefined },
      {},
      190_000,
    ),
    190_000,
  );
});

test('daemon settings keep an already-resolved limit when defaults are not reapplied', () => {
  // The resume path resolves the effective limit via resumedCompactionTokenLimit
  // first, then passes empty defaults so a current per-model default cannot
  // override it.
  assert.deepEqual(
    daemonCompactionSettings('model-a', { compactionTokenLimit: 120_000 }, {}, 190_000),
    { compactionThresholdCheckEnabled: true, compactionTokenLimit: 120_000 },
  );
  // Re-supplying defaults with a per-model entry would override the resolved
  // value, which is exactly the regression the resume call avoids by passing {}.
  assert.deepEqual(
    daemonCompactionSettings(
      'model-a',
      { compactionTokenLimit: 120_000 },
      {
        compactionTokenLimitPerModel: { 'model-a': 200_000 },
      },
    ),
    { compactionThresholdCheckEnabled: true, compactionTokenLimit: 200_000 },
  );
});

test('resume threshold honors an init-exposed compaction limit ahead of current defaults', () => {
  // When the resumed SDK init settings expose a compactionTokenLimit, it wins
  // over the current Factory defaults.
  assert.equal(
    resumedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimit: 120_000, compactionTokenLimitPerModel: undefined },
      { compactionTokenLimit: 200_000 },
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
    resumedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimit: undefined, compactionTokenLimitPerModel: undefined },
      { compactionTokenLimit: 200_000 },
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

test('resume/swap compaction model resolves the mode-specific default for a reset-to-Default session', () => {
  // A reset-to-Default session exposes no explicit model, so reasserting daemon
  // compaction must resolve the session mode's default model (spec / mission
  // orchestrator differ from the global chat default) for the right per-model
  // trigger and window. This is the resolution the resume and swap reasserts use
  // via defaultModelForAgent('orchestrator', modeForSummary(summary), defaults).
  const defaults = {
    modelId: 'chat-default',
    specModelId: 'spec-default',
    missionOrchestratorModelId: 'mission-default',
  } as FactoryDefaultSettings;
  assert.equal(
    defaultModelForAgent(
      'orchestrator',
      modeForSummary({ kind: 'spec' } as MissionSummary),
      defaults,
    ),
    'spec-default',
  );
  assert.equal(
    defaultModelForAgent(
      'orchestrator',
      modeForSummary({ kind: 'mission_orchestrator' } as MissionSummary),
      defaults,
    ),
    'mission-default',
  );
  assert.equal(
    defaultModelForAgent(
      'orchestrator',
      modeForSummary({ kind: 'chat' } as MissionSummary),
      defaults,
    ),
    'chat-default',
  );
  // Falls back to the global default when the mode default is unset.
  assert.equal(
    defaultModelForAgent('orchestrator', modeForSummary({ kind: 'spec' } as MissionSummary), {
      modelId: 'chat-default',
    } as FactoryDefaultSettings),
    'chat-default',
  );
});

test('readSessionCompacted ignores notifications that are not session_compacted', () => {
  assert.equal(readSessionCompacted({ type: 'assistant_text_delta', text: 'hi' }), null);
  assert.equal(readSessionCompacted({ params: { notification: { type: 'other' } } }), null);
  assert.equal(readSessionCompacted(null), null);
});

test('readSessionCompacted unwraps a wrapped session_compacted notification', () => {
  assert.deepEqual(
    readSessionCompacted({
      params: {
        notification: {
          type: 'session_compacted',
          summaryId: 's1',
          removedCount: 7,
          visibleBoundaryMessageId: 'm9',
        },
      },
    }),
    { summaryId: 's1', removedCount: 7, visibleBoundaryMessageId: 'm9' },
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
  noopCompaction = false;
  initResult: unknown = undefined;
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

  async compactSession(): Promise<{ newSessionId: string; removedCount: number } | null> {
    if (this.failCompaction) throw new Error('transient compaction failure');
    if (this.noopCompaction) return null;
    this.compactions += 1;
    return { newSessionId: this.swapTo ?? this.sessionId, removedCount: 4 };
  }

  async close(): Promise<void> {}
}

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
    terminalAgents: new Set<string>(),
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

test('daemon in-place compaction reflects on the orchestrator: counts it and drops a top-level divider', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  let notify: ((note: Record<string, unknown>) => void) | undefined;
  const session = {
    sessionId: 'droid-live',
    onNotification(cb: (note: Record<string, unknown>) => void): () => void {
      notify = cb;
      return () => {
        notify = undefined;
      };
    },
    async getContextStats() {
      return {
        used: 12_000,
        remaining: 988_000,
        limit: 1_000_000,
        accuracy: 'exact' as const,
        updatedAt: new Date().toISOString(),
      };
    },
  };
  const mission = {
    summary: testSummary('app-live', 'droid-live'),
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
    compacting: false,
    todoDisabledForDesign: undefined as boolean | undefined,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
    };
    missions: Map<string, typeof mission>;
    subscribeSessionCompacted: (
      appId: string,
      s: typeof session,
      agentId: string,
      role: 'orchestrator',
    ) => () => void;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
  };
  internals.missions.set('app-live', mission);

  internals.subscribeSessionCompacted('app-live', session, 'app-live', 'orchestrator');
  notify?.({ params: { notification: { type: 'session_compacted', removedCount: 9 } } });

  // The in-place compaction is counted so the context meter resets its floor...
  assert.equal(mission.summary.compactionCount, 1);
  // ...reflected as a top-level compaction divider (never folded into activity)...
  const divider = events.find(
    (e) =>
      e.type === 'mission.transcript' &&
      (e as { event?: { kind?: string } }).event?.kind === 'compaction',
  ) as { event?: { compactType?: string; removedCount?: number } } | undefined;
  assert.equal(divider?.event?.compactType, 'auto');
  assert.equal(divider?.event?.removedCount, 9);
  // ...and never mints a new backing id (the daemon compacts in place).
  assert.equal(mission.summary.sessionId, 'droid-live');

  // Manual /compact owns its own reflection, so a notification fired while it is
  // running must not double-count.
  mission.compacting = true;
  notify?.({ params: { notification: { type: 'session_compacted', removedCount: 3 } } });
  assert.equal(mission.summary.compactionCount, 1);
});

test('manual compaction adopts the daemon-minted session id and counts the compaction', async () => {
  const { manager, events, mission, internals } = orchestratorSwapHarness(120_000, 'droid-new');
  const swapped = new FakeCompactionSession('droid-new', 10_000);
  internals.runtime = { loadSession: async () => swapped };
  (
    manager as unknown as { getFactoryDefaults: () => Promise<Record<string, unknown>> }
  ).getFactoryDefaults = async () => ({});
  await manager.handle({ type: 'mission.compact', missionId: 'app-swap' });
  // The explicit compactSession() mints a new backing id, adopted behind the
  // stable app id so the visible chat is unchanged.
  assert.equal(mission.session.sessionId, 'droid-new');
  assert.equal(mission.summary.sessionId, 'droid-new');
  // The compaction is counted (drives the context-meter reset)...
  assert.equal(mission.summary.compactionCount, 1);
  // ...and recorded as a top-level compaction divider.
  const divider = events.find(
    (e) =>
      e.type === 'mission.transcript' &&
      (e as { event?: { kind?: string } }).event?.kind === 'compaction',
  ) as { event?: { compactType?: string; removedCount?: number } } | undefined;
  assert.equal(divider?.event?.compactType, 'manual');
  assert.equal(divider?.event?.removedCount, 4);
  assert.equal(internals.missions.has('app-swap'), true);
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
});

test('manual compaction preserves the compaction trigger the swapped session exposes', async () => {
  const { manager, mission, internals } = orchestratorSwapHarness(120_000, 'droid-new');
  const swapped = new FakeCompactionSession('droid-new', 10_000);
  // The new backing session exposes the same global trigger the chat ran with.
  swapped.initResult = { settings: { compactionTokenLimit: 55_000 } };
  internals.runtime = { loadSession: async () => swapped };
  (
    manager as unknown as { getFactoryDefaults: () => Promise<Record<string, unknown>> }
  ).getFactoryDefaults = async () => ({ compactionTokenLimit: 999_000 });

  await manager.handle({ type: 'mission.compact', missionId: 'app-swap' });

  // The swapped session re-asserts daemon compaction honoring the limit it
  // exposes (55_000), not the current global default (999_000), so adopting the
  // new backing id can't silently change the threshold.
  assert.equal(mission.summary.sessionId, 'droid-new');
  assert.deepEqual(swapped.settingsUpdates.at(-1), {
    compactionThresholdCheckEnabled: true,
    compactionTokenLimit: 55_000,
  });
});

test('manual compaction is a no-op when the daemon reports nothing to compact', async () => {
  const { manager, events, mission, session } = orchestratorSwapHarness(10_000, 'droid-new');
  session.noopCompaction = true;
  (
    manager as unknown as { getFactoryDefaults: () => Promise<Record<string, unknown>> }
  ).getFactoryDefaults = async () => ({});

  await manager.handle({ type: 'mission.compact', missionId: 'app-swap' });

  // compactSession() returned null: leave the conversation untouched, with no
  // backing-id swap, no count bump, no divider, and no error surfaced.
  assert.equal(mission.session.sessionId, 'droid-old');
  assert.equal(mission.summary.sessionId, 'droid-old');
  assert.equal(mission.summary.compactionCount ?? 0, 0);
  assert.equal(session.compactions, 0);
  assert.equal(
    events.some(
      (e) =>
        e.type === 'mission.transcript' &&
        (e as { event?: { kind?: string } }).event?.kind === 'compaction',
    ),
    false,
  );
  assert.equal(
    events.some((e) => e.type === 'mission.error'),
    false,
  );
  // A terminal status must close out the "Compacting…" shimmer, which the chat
  // derives from the latest status line; otherwise it hangs indefinitely.
  assert.equal(
    events.some(
      (e) =>
        e.type === 'mission.transcript' &&
        (e as { event?: { kind?: string; text?: string } }).event?.kind === 'status' &&
        (e as { event?: { text?: string } }).event?.text === 'Nothing to compact.',
    ),
    true,
  );
});

test('session.updateSettings re-applies daemon compaction for the switched model', async () => {
  const { manager, session } = orchestratorSwapHarness(10_000, 'droid-new');
  (
    manager as unknown as { getFactoryDefaults: () => Promise<Record<string, unknown>> }
  ).getFactoryDefaults = async () => ({
    compactionTokenLimitPerModel: { 'model-x': 150_000 },
  });

  await manager.handle({
    type: 'session.updateSettings',
    sessionId: 'app-swap',
    modelId: 'model-x',
  });

  // Switching the session model must re-assert the daemon trigger for that
  // model; without it the session keeps the previous model's threshold.
  assert.deepEqual(session.settingsUpdates.at(-1), {
    compactionThresholdCheckEnabled: true,
    compactionTokenLimit: 150_000,
  });
});

test('a worker auto-compaction during an orchestrator manual compaction still reflects', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = {
    sessionId: 'worker-droid',
    async getContextStats() {
      return {
        used: 5_000,
        remaining: 995_000,
        limit: 1_000_000,
        accuracy: 'exact' as const,
        updatedAt: new Date().toISOString(),
      };
    },
  };
  const mission = {
    summary: testSummary('app-mc', 'orch-droid'),
    session,
    compacting: true,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
    };
    missions: Map<string, typeof mission>;
    handleSessionCompacted: (
      appId: string,
      agentId: string,
      role: 'orchestrator' | 'worker',
      s: typeof session,
      info: { removedCount: number },
    ) => void;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
  };
  internals.missions.set('app-mc', mission);

  // The orchestrator is mid manual compaction (mission.compacting). A worker
  // auto-compacting in the same window is unrelated and must still surface its
  // divider, without bumping the orchestrator generation counter.
  internals.handleSessionCompacted('app-mc', 'worker-droid', 'worker', session, {
    removedCount: 7,
  });
  const workerDivider = events.find(
    (e) =>
      e.type === 'mission.transcript' &&
      (e as { event?: { kind?: string } }).event?.kind === 'compaction',
  ) as { event?: { compactType?: string; removedCount?: number; role?: string } } | undefined;
  assert.equal(workerDivider?.event?.compactType, 'auto');
  assert.equal(workerDivider?.event?.removedCount, 7);
  assert.equal(workerDivider?.event?.role, 'worker');
  assert.equal(mission.summary.compactionCount ?? 0, 0);

  // The orchestrator's own daemon notification is still suppressed while its
  // manual compaction owns the reflection.
  events.length = 0;
  internals.handleSessionCompacted('app-mc', 'orch-droid', 'orchestrator', session, {
    removedCount: 3,
  });
  assert.equal(
    events.some(
      (e) =>
        e.type === 'mission.transcript' &&
        (e as { event?: { kind?: string } }).event?.kind === 'compaction',
    ),
    false,
  );
});

test('changing the orchestrator model re-applies daemon compaction for the resolved model', async () => {
  const { manager, session } = orchestratorSwapHarness(10_000, 'droid-new');
  (
    manager as unknown as { getFactoryDefaults: () => Promise<Record<string, unknown>> }
  ).getFactoryDefaults = async () => ({
    modelId: 'default-model',
    compactionTokenLimitPerModel: { 'model-x': 150_000, 'default-model': 120_000 },
  });

  // Switching to a concrete model re-asserts that model's per-model trigger.
  await manager.handle({
    type: 'settings.agent.update',
    agent: 'orchestrator',
    missionId: 'app-swap',
    modelId: 'model-x',
  });
  assert.deepEqual(session.settingsUpdates.at(-1), {
    compactionThresholdCheckEnabled: true,
    compactionTokenLimit: 150_000,
  });

  // Resetting to Default clears summary.modelId; the daemon trigger must follow
  // the resolved default model's per-model limit, not drop to a no-limit trigger.
  await manager.handle({
    type: 'settings.agent.update',
    agent: 'orchestrator',
    missionId: 'app-swap',
    modelId: null,
  });
  assert.deepEqual(session.settingsUpdates.at(-1), {
    compactionThresholdCheckEnabled: true,
    compactionTokenLimit: 120_000,
  });
});

test('applying a queued orchestrator model change re-asserts daemon compaction for the resolved model', async () => {
  const { manager, session } = orchestratorSwapHarness(10_000, 'droid-new');
  (
    manager as unknown as { getFactoryDefaults: () => Promise<Record<string, unknown>> }
  ).getFactoryDefaults = async () => ({
    modelId: 'default-model',
    compactionTokenLimitPerModel: { 'default-model': 120_000 },
  });
  const internals = manager as unknown as {
    pendingAgentSettings: Map<string, Record<string, { modelId?: string | null }>>;
    applyPendingSessionSettings: (id: string) => Promise<boolean>;
  };
  // A reset-to-Default queued while the session was historical and applied here
  // right before the next send (not via the live settings.agent.update path).
  internals.pendingAgentSettings.set('app-swap', { orchestrator: { modelId: null } });

  const ok = await internals.applyPendingSessionSettings('app-swap');
  assert.equal(ok, true);
  // The resolved default model's per-model trigger is re-asserted; without this
  // the queued switch would silently drop to a no-limit daemon trigger.
  assert.deepEqual(session.settingsUpdates.at(-1), {
    compactionThresholdCheckEnabled: true,
    compactionTokenLimit: 120_000,
  });
});

test('a queued reasoning-only change does not re-assert daemon compaction', async () => {
  const { manager, session } = orchestratorSwapHarness(10_000, 'droid-new');
  (
    manager as unknown as { getFactoryDefaults: () => Promise<Record<string, unknown>> }
  ).getFactoryDefaults = async () => ({ modelId: 'default-model' });
  const internals = manager as unknown as {
    pendingAgentSettings: Map<string, Record<string, { reasoningEffort?: string }>>;
    applyPendingSessionSettings: (id: string) => Promise<boolean>;
  };
  internals.pendingAgentSettings.set('app-swap', { orchestrator: { reasoningEffort: 'high' } });

  await internals.applyPendingSessionSettings('app-swap');
  // No model change means the model-derived trigger is unchanged, so the only
  // settings push is the reasoning update, not a compaction re-assert.
  assert.equal(
    session.settingsUpdates.some((u) => 'compactionThresholdCheckEnabled' in u),
    false,
  );
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

test('manual compaction that fails to reload still counts the compaction before dropping the mission', async () => {
  const { manager, mission, internals } = orchestratorSwapHarness(10_000, 'droid-new');
  internals.runtime = {
    loadSession: async () => {
      throw new Error('permanent load failure');
    },
  };
  (manager as unknown as { closeMission: (id: string) => Promise<void> }).closeMission = async (
    id: string,
  ) => {
    internals.missions.delete(id);
  };
  await manager.handle({ type: 'mission.compact', missionId: 'app-swap' });
  // Adoption never succeeds, so the live mission is dropped, but the compaction
  // still happened: persist the new backing id AND bump the count so a later
  // resume keeps the right context-meter generation instead of a stale one.
  assert.equal(mission.summary.sessionId, 'droid-new');
  assert.equal(mission.summary.compactionCount, 1);
});

test('compacting a historical session bumps the persisted compaction count', async () => {
  const synced: MissionSummary[] = [];
  const manager = new MissionManager(() => {});
  const internals = manager as unknown as {
    history: { syncSummaries: (s: MissionSummary[]) => void };
    resolveSummary: (id: string) => MissionSummary | undefined;
    withSession: <T>(
      id: string,
      fn: (s: { compactSession: () => Promise<unknown> }) => Promise<T>,
    ) => Promise<T>;
    compactHistoricalSession: (id: string, instructions?: string) => Promise<void>;
  };
  const historical = { ...testSummary('app-hist', 'hist-old'), compactionCount: 2 };
  internals.history = { syncSummaries: (s: MissionSummary[]) => synced.push(...s) } as never;
  internals.resolveSummary = () => historical;
  internals.withSession = async (_id, fn) =>
    fn({ compactSession: async () => ({ newSessionId: 'hist-new', removedCount: 5 }) });

  await internals.compactHistoricalSession('hist-old');

  const updated = synced.find((s) => s.sessionId === 'hist-new');
  // The minted id is persisted with an incremented count so the monotonic
  // MAX(...) upsert can't leave a compacted historical conversation undercounted.
  assert.equal(updated?.compactionCount, 3);
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
