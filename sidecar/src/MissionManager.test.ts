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
  callOrder: string[] = [];
  private releaseFirstTurn?: () => void;

  constructor(readonly sessionId: string) {}

  async *stream(prompt: string): AsyncGenerator<never, void, undefined> {
    this.prompts.push(prompt);
    this.callOrder.push(`stream:${prompt}`);
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
    if ('compactionTokenLimit' in params || 'compactionThresholdCheckEnabled' in params)
      this.callOrder.push(`compaction:${params.compactionTokenLimit ?? 'off'}`);
    else this.callOrder.push('settings');
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

test('uses Factory per-model compaction defaults when local overrides omit the model', () => {
  assert.equal(
    compactionTokenLimitForModel(
      'model-a',
      { compactionTokenLimitPerModel: {} },
      { compactionTokenLimitPerModel: { 'model-a': 400_000 } },
    ),
    400_000,
  );
});

test('uses local global compaction limits ahead of Factory per-model defaults', () => {
  assert.equal(
    compactionTokenLimitForModel(
      'model-a',
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: {} },
      { compactionTokenLimitPerModel: { 'model-a': 400_000 } },
    ),
    200_000,
  );
});

test('explicitly cleared global compaction limit disables Factory per-model defaults', () => {
  assert.equal(
    compactionTokenLimitForModel(
      'model-a',
      { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
      { compactionTokenLimitPerModel: { 'model-a': 400_000 } },
    ),
    undefined,
  );
});

test('uses Factory compaction defaults when command omits them', () => {
  assert.equal(
    compactionTokenLimitForModel('model-a', {}, { compactionTokenLimit: 200_000 }),
    200_000,
  );
});

test('builds Droid compaction payloads from the selected daemon budget', () => {
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

test('Factory default enables daemon threshold checks without forcing a budget', () => {
  assert.deepEqual(createCompactionSettingsForModel('model-a', {}, {}), {
    compactionThresholdCheckEnabled: true,
  });
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

test('disables daemon compaction threshold checks when budget is explicitly off', () => {
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

test('compaction settings patches preserve omitted fields', () => {
  const manager = new MissionManager(() => {});
  const internals = manager as unknown as {
    compactionSettingsForCommand: (settings?: {
      compactionTokenLimit?: number | null | 'factory-default';
      compactionTokenLimitPerModel?: Record<string, number>;
    }) => {
      compactionTokenLimit?: number | null;
      compactionTokenLimitPerModel?: Record<string, number>;
    };
  };

  assert.deepEqual(
    internals.compactionSettingsForCommand({
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: {},
    }),
    { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
  );
  assert.deepEqual(
    internals.compactionSettingsForCommand({
      compactionTokenLimitPerModel: { 'model-a': 120_000 },
    }),
    {
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: { 'model-a': 120_000 },
    },
  );
  assert.deepEqual(internals.compactionSettingsForCommand({ compactionTokenLimit: 200_000 }), {
    compactionTokenLimit: 200_000,
    compactionTokenLimitPerModel: { 'model-a': 120_000 },
  });
  assert.deepEqual(
    internals.compactionSettingsForCommand({ compactionTokenLimit: 'factory-default' }),
    { compactionTokenLimitPerModel: { 'model-a': 120_000 } },
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

test('plain interrupt stops the live turn without surfacing a stream error', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeSession('droid-stop');
  const mission = {
    summary: testSummary('app-stop', session.sessionId),
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

  await manager.handle({ type: 'mission.interrupt', missionId: mission.summary.id });
  await firstTurn;

  assert.equal(session.interrupts, 1);
  assert.equal(mission.streaming, false);
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

test('emits live daemon compaction disable payloads when budget is explicitly off', () => {
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

test('live sessions refresh daemon compaction settings from model and limit changes', async () => {
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

  mission.streaming = true;
  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: 200_000,
    compactionTokenLimitPerModel: { 'model-a': 150_000 },
  });

  assert.deepEqual(session.settingsUpdates.at(-1), {
    compactionTokenLimit: 150_000,
    compactionThresholdCheckEnabled: true,
  });
  mission.streaming = false;

  await manager.handle({
    type: 'settings.agent.update',
    missionId: mission.summary.id,
    agent: 'orchestrator',
    modelId: 'model-b',
  });

  assert.deepEqual(session.settingsUpdates.at(-1), {
    modelId: 'model-b',
    compactionTokenLimit: 200_000,
    compactionThresholdCheckEnabled: true,
  });

  await manager.handle({
    type: 'mission.send',
    missionId: mission.summary.id,
    text: 'existing chat turn',
    compactionTokenLimit: 180_000,
    compactionTokenLimitPerModel: {},
  });

  assert.equal(
    session.settingsUpdates.some(
      (update) =>
        update.compactionTokenLimit === 180_000 && update.compactionThresholdCheckEnabled === true,
    ),
    true,
  );
  const compactionUpdateIndex = session.callOrder.lastIndexOf('compaction:180000');
  const streamIndex = session.callOrder.indexOf('stream:existing chat turn');
  assert.equal(compactionUpdateIndex >= 0, true);
  assert.equal(streamIndex >= 0, true);
  assert.equal(compactionUpdateIndex < streamIndex, true);
  assert.deepEqual(session.prompts.at(-1), 'existing chat turn');
  assert.equal(
    events.some((event) => event.type === 'mission.error' || event.type === 'error'),
    false,
  );
});

test('live compaction updates preserve cleared global limits when fields are omitted', async () => {
  const { manager, session, mission, internals } = streamHarness(10_000);
  mission.summary.modelId = 'model-a';
  (
    internals as unknown as {
      getFactoryDefaults: () => Promise<{
        modelId?: string;
        compactionTokenLimit?: number;
        compactionTokenLimitPerModel?: Record<string, number>;
      }>;
    }
  ).getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimit: 400_000,
    compactionTokenLimitPerModel: {},
  });

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: null,
    compactionTokenLimitPerModel: {},
  });

  assert.deepEqual(session.settingsUpdates.at(-1), {
    compactionThresholdCheckEnabled: false,
  });

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimitPerModel: { 'model-b': 200_000 },
  });

  assert.deepEqual(session.settingsUpdates.at(-1), {
    compactionThresholdCheckEnabled: false,
  });
});

test('live compaction updates restore Factory default global limits', async () => {
  const { manager, session, mission, internals } = streamHarness(10_000);
  mission.summary.modelId = 'model-a';
  (
    internals as unknown as {
      getFactoryDefaults: () => Promise<{
        modelId?: string;
        compactionTokenLimit?: number;
      }>;
    }
  ).getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimit: 400_000,
  });

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: 200_000,
    compactionTokenLimitPerModel: {},
  });

  assert.deepEqual(session.settingsUpdates.at(-1), {
    compactionTokenLimit: 200_000,
    compactionThresholdCheckEnabled: true,
  });

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: 'factory-default',
    compactionTokenLimitPerModel: {},
  });

  assert.deepEqual(session.settingsUpdates.at(-1), {
    compactionTokenLimit: 400_000,
    compactionThresholdCheckEnabled: true,
  });
});

test('live compaction updates restore Factory default per-model limits', async () => {
  const { manager, session, mission, internals } = streamHarness(10_000);
  mission.summary.modelId = 'model-a';
  (
    internals as unknown as {
      getFactoryDefaults: () => Promise<{
        modelId?: string;
        compactionTokenLimitPerModel?: Record<string, number>;
      }>;
    }
  ).getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimitPerModel: { 'model-a': 400_000 },
  });

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimitPerModel: { 'model-a': 200_000 },
  });

  assert.deepEqual(session.settingsUpdates.at(-1), {
    compactionTokenLimit: 200_000,
    compactionThresholdCheckEnabled: true,
  });

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: 'factory-default',
    compactionTokenLimitPerModel: {},
  });

  assert.deepEqual(session.settingsUpdates.at(-1), {
    compactionTokenLimit: 400_000,
    compactionThresholdCheckEnabled: true,
  });
});

test('live compaction updates refresh the visible context meter immediately', async () => {
  const { manager, session, mission, events, internals } = streamHarness(10_000);
  mission.summary.modelId = 'model-a';
  mission.summary.maxContextTokens = 400_000;
  session.limit = 1_000_000;
  (
    internals as unknown as {
      getFactoryDefaults: () => Promise<{
        modelId?: string;
        compactionTokenLimit?: number;
      }>;
    }
  ).getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimit: 400_000,
  });

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: 200_000,
    compactionTokenLimitPerModel: {},
  });

  const contextEvent = events.findLast((event) => event.type === 'context.updated') as
    | { type: 'context.updated'; stats: { used: number; remaining: number; limit: number } }
    | undefined;
  const tokenEvent = events.findLast((event) => event.type === 'mission.tokens') as
    | { type: 'mission.tokens'; maxContextTokens?: number }
    | undefined;
  assert.equal(contextEvent?.stats.used, 10_000);
  assert.equal(contextEvent?.stats.remaining, 190_000);
  assert.equal(contextEvent?.stats.limit, 200_000);
  assert.equal(tokenEvent?.maxContextTokens, 200_000);
  assert.equal(mission.summary.maxContextTokens, 200_000);
});

test('resume refreshes daemon compaction settings with the selected budget', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeCompactionSession('droid-resume', 10_000) as FakeCompactionSession & {
    initResult: Record<string, unknown>;
  };
  session.initResult = {
    cwd: '',
    session: { title: 'Resumed compacted session' },
    settings: { modelId: 'model-a' },
  };
  const historical: MissionSummary = {
    ...testSummary('app-resume', session.sessionId),
    modelId: 'model-a',
    compactionCount: 2,
    compactedFromSessionIds: [],
  };
  const internals = manager as unknown as {
    ready: boolean;
    resolveSummary: (id: string) => MissionSummary | undefined;
    startLocalMcpServers: () => Promise<{ servers: []; configs: [] }>;
    getFactoryDefaults: () => Promise<{
      modelId?: string;
      compactionTokenLimit?: number;
      compactionTokenLimitPerModel?: Record<string, number>;
    }>;
    runtime: {
      loadSession: (id: string, handlers: unknown) => Promise<typeof session>;
    };
    history: {
      syncSummaries: () => void;
      subagentLinks: () => [];
      summaryPatches: () => Map<string, Partial<MissionSummary>>;
      hiddenDroidSessionIds: () => Set<string>;
    };
    missions: Map<string, { summary: MissionSummary; session: typeof session }>;
  };
  internals.ready = true;
  internals.resolveSummary = () => historical;
  internals.startLocalMcpServers = async () => ({ servers: [], configs: [] });
  internals.getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimit: 180_000,
  });
  internals.runtime = {
    loadSession: async () => session,
  };
  internals.history = {
    syncSummaries: () => {},
    subagentLinks: () => [],
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
  };

  await manager.handle({
    type: 'mission.resume',
    sessionId: historical.id,
    compactionTokenLimit: 100_000,
    compactionTokenLimitPerModel: {},
  });

  const live = internals.missions.get(historical.id);
  assert.equal(live?.summary.compactionCount, 2);
  assert.equal(session.callOrder.includes('compaction:100000'), true);
  assert.equal(session.callOrder.includes('compaction:144000'), false);
  assert.equal(
    events.some((event) => event.type === 'mission.created' && event.mission.compactionCount === 2),
    true,
  );
});

test('agent sends refresh daemon compaction settings before streaming', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeSession('droid-agent-parent');
  const agentSession = new FakeSession('worker-1');
  const mission = {
    summary: {
      ...testSummary('app-agent-settings', session.sessionId),
      modelId: 'model-a',
      maxContextTokens: 500_000,
    },
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    agents: new Map([
      [
        agentSession.sessionId,
        {
          session: agentSession,
          missionId: 'app-agent-settings',
          role: 'worker' as const,
          streaming: false,
          pendingSends: [],
          lastUsedAt: Date.now(),
        },
      ],
    ]),
    knownSubagents: new Set([agentSession.sessionId]),
    completedSubagents: new Set(),
    linkedSubagents: new Set(),
    subagentToolUseIds: new Map(),
    subagentSettings: new Map([[agentSession.sessionId, { modelId: 'worker-model' }]]),
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
  };
  internals.getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimit: 400_000,
    compactionTokenLimitPerModel: {},
  });
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
    type: 'agent.send',
    missionId: mission.summary.id,
    agentSessionId: agentSession.sessionId,
    text: 'worker turn',
    compactionTokenLimit: 200_000,
    compactionTokenLimitPerModel: { 'worker-model': 175_000 },
  });

  assert.deepEqual(agentSession.settingsUpdates.at(-1), {
    compactionTokenLimit: 175_000,
    compactionThresholdCheckEnabled: true,
  });
  const compactionUpdateIndex = agentSession.callOrder.lastIndexOf('compaction:175000');
  const streamIndex = agentSession.callOrder.indexOf('stream:worker turn');
  assert.equal(compactionUpdateIndex >= 0, true);
  assert.equal(streamIndex >= 0, true);
  assert.equal(compactionUpdateIndex < streamIndex, true);
  assert.deepEqual(agentSession.prompts, ['worker turn']);
  assert.equal(
    events.some((event) => event.type === 'mission.error' || event.type === 'error'),
    false,
  );
});

test('agent sends use mission worker model for live compaction settings', async () => {
  const { manager, mission } = streamHarness(0);
  const worker = new FakeCompactionSession('worker-mission-model', 10_000);
  mission.summary.kind = 'mission_orchestrator';
  mission.summary.modelId = 'orchestrator-model';
  mission.summary.workerModelId = 'mission-worker';
  mission.knownSubagents.add(worker.sessionId);
  mission.agents.set(worker.sessionId, {
    session: worker,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: false,
    pendingSends: [],
    lastUsedAt: Date.now(),
  });
  (
    manager as unknown as {
      getFactoryDefaults: () => Promise<{
        modelId?: string;
        workerModelId?: string;
        compactionTokenLimitPerModel?: Record<string, number>;
      }>;
    }
  ).getFactoryDefaults = async () => ({
    modelId: 'orchestrator-model',
    workerModelId: 'factory-worker',
    compactionTokenLimitPerModel: {
      'factory-worker': 100_000,
      'mission-worker': 180_000,
    },
  });

  await manager.handle({
    type: 'agent.send',
    missionId: mission.summary.id,
    agentSessionId: worker.sessionId,
    text: 'worker turn',
    compactionTokenLimitPerModel: {
      'factory-worker': 100_000,
      'mission-worker': 180_000,
    },
  });

  assert.deepEqual(worker.settingsUpdates.at(-1), {
    compactionTokenLimit: 180_000,
    compactionThresholdCheckEnabled: true,
  });

  mission.summary.workerModelId = undefined;
  await manager.handle({
    type: 'agent.send',
    missionId: mission.summary.id,
    agentSessionId: worker.sessionId,
    text: 'worker default turn',
    compactionTokenLimitPerModel: {
      'factory-worker': 100_000,
      'mission-worker': 180_000,
    },
  });

  assert.deepEqual(worker.settingsUpdates.at(-1), {
    compactionTokenLimit: 100_000,
    compactionThresholdCheckEnabled: true,
  });
});

test('discovered subagents receive daemon compaction settings before manual open', async () => {
  const { manager, session, mission, internals } = streamHarness(10_000);
  const worker = new FakeCompactionSession('worker-discovered', 5_000) as FakeCompactionSession & {
    initResult: Record<string, unknown>;
  };
  worker.initResult = { settings: { modelId: 'worker-model' } };
  const discoveredInternals = internals as unknown as {
    runtime: { loadSession: (id: string, handlers: unknown) => Promise<typeof worker> };
    getFactoryDefaults: () => Promise<{ compactionTokenLimitPerModel?: Record<string, number> }>;
  };
  discoveredInternals.runtime = { loadSession: async () => worker };
  discoveredInternals.getFactoryDefaults = async () => ({
    compactionTokenLimitPerModel: { 'worker-model': 175_000 },
  });
  session.streamEvents = [
    {
      type: 'tool_progress',
      toolUseId: 'tool-1',
      update: {
        subagentSessionId: worker.sessionId,
        parameters: { subagent_type: 'worker' },
      },
    },
  ];

  await manager.handle({
    type: 'mission.send',
    missionId: mission.summary.id,
    text: 'spawn worker',
    compactionTokenLimitPerModel: { 'worker-model': 175_000 },
  });

  await waitFor(() => worker.callOrder.includes('compaction:175000'));
  assert.equal(mission.agents.get(worker.sessionId)?.session, worker);
  assert.equal(worker.notificationHandler !== undefined, true);
});

test('permission and question responses refresh compaction settings before continuation', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeSession('droid-response-settings');
  const mission = {
    summary: {
      ...testSummary('app-response-settings', session.sessionId),
      modelId: 'model-a',
      maxContextTokens: 500_000,
    },
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map([
      [
        'req-permission',
        {
          resolve: () => session.callOrder.push('permission-resolved'),
          kind: 'other' as const,
        },
      ],
    ]),
    pendingQuestions: new Map([
      ['req-question', () => session.callOrder.push('question-resolved')],
    ]),
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
  };
  internals.getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimit: 400_000,
    compactionTokenLimitPerModel: {},
  });
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
    type: 'mission.respondPermission',
    missionId: mission.summary.id,
    requestId: 'req-permission',
    outcome: 'proceed_once',
    compactionTokenLimit: 190_000,
    compactionTokenLimitPerModel: {},
  });

  await manager.handle({
    type: 'mission.respondQuestion',
    missionId: mission.summary.id,
    requestId: 'req-question',
    cancelled: false,
    answers: [{ index: 0, question: 'Continue?', answer: 'yes' }],
    compactionTokenLimit: 180_000,
    compactionTokenLimitPerModel: {},
  });

  assert.deepEqual(session.callOrder, [
    'compaction:190000',
    'permission-resolved',
    'compaction:180000',
    'question-resolved',
  ]);
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

test('quiet defaults lookup does not surface model catalog errors', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const internals = manager as unknown as {
    getFactoryDefaults: () => Promise<unknown>;
    runtime: {
      status: () => { mode: 'cli_auth'; droidPath: string; apiKeyConfigured: boolean };
    };
  };
  internals.runtime = {
    status: () => ({
      mode: 'cli_auth',
      droidPath: '/definitely/missing/droid',
      apiKeyConfigured: false,
    }),
  };

  await internals.getFactoryDefaults();

  assert.equal(
    events.some((event) => event.type === 'mission.error' || event.type === 'error'),
    false,
  );
});

class FakeCompactionSession {
  prompts: string[] = [];
  callOrder: string[] = [];
  compactions = 0;
  interrupts = 0;
  failCompaction = false;
  usedAfterCompact?: number;
  usedAfterStream?: number;
  streamEvents: Record<string, unknown>[] = [];
  usedBeforeStreamEvent?: number;
  limit = 1_000_000;
  accuracy: 'exact' | 'estimated' = 'exact';
  beforeStream?: (prompt: string) => Promise<void> | void;
  breakdown?: unknown;
  beforeContextStats?: () => Promise<void> | void;
  beforeCompact?: () => Promise<void> | void;
  beforeClose?: () => Promise<void> | void;
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
    await this.beforeStream?.(prompt);
    for (const event of this.streamEvents) {
      if (this.usedBeforeStreamEvent !== undefined) this.used = this.usedBeforeStreamEvent;
      yield event;
    }
    if (this.usedAfterStream !== undefined) this.used = this.usedAfterStream;
  }

  async updateSettings(params: Record<string, unknown>): Promise<void> {
    this.settingsUpdates.push(params);
    if ('compactionTokenLimit' in params || 'compactionThresholdCheckEnabled' in params)
      this.callOrder.push(`compaction:${params.compactionTokenLimit ?? 'off'}`);
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
    await this.beforeCompact?.();
    this.compactions += 1;
    if (this.usedAfterCompact !== undefined) this.used = this.usedAfterCompact;
    return { newSessionId: this.swapTo ?? this.sessionId, removedCount: 4 };
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async close(): Promise<void> {
    await this.beforeClose?.();
  }
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
    getFactoryDefaults: () => Promise<{ modelId?: string; compactionTokenLimit?: number }>;
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
  internals.getFactoryDefaults = async () => ({});
  internals.missions.set(mission.summary.id, mission);
  return { manager, session, events, mission, internals };
}

test('routes daemon compacted notifications from orchestrator sessions', async () => {
  const events: ServerEvent[] = [];
  const manager = new MissionManager((event) => events.push(event));
  const session = new FakeCompactionSession('droid-notify', 10_000);
  const summary = { ...testSummary('app-notify', session.sessionId), modelId: 'model-a' };
  const internals = manager as unknown as {
    createLiveMission: (
      summary: MissionSummary,
      session: FakeCompactionSession,
      mcpServers?: [],
      mcpConfigs?: [],
    ) => {
      summary: MissionSummary;
      session: FakeCompactionSession;
      unsubscribe?: () => void;
    };
    getFactoryDefaults: () => Promise<{
      modelId?: string;
      compactionTokenLimit?: number;
      compactionTokenLimitPerModel?: Record<string, number>;
    }>;
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, Partial<MissionSummary>>;
      hiddenDroidSessionIds: () => Set<string>;
      recordSubagentLink: () => void;
      subagentLinks: () => [];
    };
    missions: Map<
      string,
      { summary: MissionSummary; session: FakeCompactionSession; unsubscribe?: () => void }
    >;
  };
  internals.getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimit: 400_000,
  });
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
    recordSubagentLink: () => {},
    subagentLinks: () => [],
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
  assert.equal(mission.summary.compactionCount, 1);
  await waitFor(() => session.callOrder.includes('compaction:400000'));

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: 180_000,
    compactionTokenLimitPerModel: {},
  });
  assert.equal(session.callOrder.includes('compaction:180000'), true);

  assert.equal(session.unsubscribed, false);
  mission.unsubscribe?.();
  assert.equal(session.unsubscribed, true);
});

test('routes daemon compacted notifications from worker sessions to worker context', async () => {
  const { manager, session, mission, events } = streamHarness(10_000);
  const worker = new FakeCompactionSession('worker-notify', 12_345);
  worker.limit = 90_000;
  mission.summary.modelId = 'model-a';
  mission.subagentSettings.set(worker.sessionId, { modelId: 'model-a' });
  mission.agents.set(worker.sessionId, {
    session: worker,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: false,
    pendingSends: [],
    lastUsedAt: Date.now(),
  });
  const internals = manager as unknown as {
    getFactoryDefaults: () => Promise<{ modelId?: string; compactionTokenLimit?: number }>;
    subscribeSessionNotifications: (
      appSessionId: string,
      agentSessionId: string,
      role: 'worker',
      session: FakeCompactionSession,
    ) => () => void;
  };
  internals.getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimit: 100_000,
  });
  const unsubscribe = internals.subscribeSessionNotifications(
    mission.summary.id,
    worker.sessionId,
    'worker',
    worker,
  );

  worker.emitNotification({ notification: { type: 'session_compacted', removedCount: 3 } });

  await waitFor(() =>
    events.some(
      (event) => event.type === 'context.updated' && event.sessionId === worker.sessionId,
    ),
  );
  const workerContext = events.findLast(
    (event) => event.type === 'context.updated' && event.sessionId === worker.sessionId,
  ) as
    | { type: 'context.updated'; stats: { used: number; remaining: number; limit: number } }
    | undefined;
  assert.equal(workerContext?.stats.used, 12_345);
  assert.equal(workerContext?.stats.remaining, 87_655);
  assert.equal(workerContext?.stats.limit, 100_000);
  assert.equal(mission.summary.compactionCount, 1);
  assert.equal(session.callOrder.includes('compaction:100000'), true);
  assert.equal(worker.callOrder.includes('compaction:100000'), true);
  unsubscribe();
});

test('ignores worker daemon compacted notifications during active worker compaction', () => {
  const { manager, mission } = streamHarness(10_000);
  const worker = new FakeCompactionSession('worker-compacting-notify', 12_345);
  mission.agents.set(worker.sessionId, {
    session: worker,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: false,
    compacting: true,
    pendingSends: [],
    lastUsedAt: Date.now(),
  });
  const internals = manager as unknown as {
    subscribeSessionNotifications: (
      appSessionId: string,
      agentSessionId: string,
      role: 'worker',
      session: FakeCompactionSession,
    ) => () => void;
  };
  const unsubscribe = internals.subscribeSessionNotifications(
    mission.summary.id,
    worker.sessionId,
    'worker',
    worker,
  );

  worker.emitNotification({ notification: { type: 'session_compacted', removedCount: 3 } });

  assert.equal(mission.summary.compactionCount ?? 0, 0);
  unsubscribe();
});

test('send leaves automatic compaction to the daemon even when over budget', async () => {
  const { manager, session, mission, events } = streamHarness(103_000);
  session.limit = 100_000;

  await manager.handle({
    type: 'mission.send',
    missionId: 'app-stream',
    text: 'hello',
    compactionTokenLimit: 100_000,
    compactionTokenLimitPerModel: {},
  });

  assert.equal(session.compactions, 0);
  assert.equal(mission.summary.compactionCount ?? 0, 0);
  assert.deepEqual(session.callOrder, ['compaction:100000', 'stream:hello']);
  assert.deepEqual(session.prompts, ['hello']);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'mission.transcript' &&
        event.event.kind === 'status' &&
        event.event.text === 'Compacting conversation...',
    ),
    false,
  );
});

test('agent visible limit uses mission validator model', () => {
  const { manager, mission } = streamHarness(0);
  const validator = new FakeCompactionSession('validator-budget', 0);
  type TestAgent = {
    session: FakeCompactionSession;
    missionId: string;
    role: 'validator';
    streaming: boolean;
    pendingSends: string[];
    lastUsedAt: number;
  };
  type TestDefaults = {
    modelId: string;
    validatorModelId: string;
    compactionTokenLimitPerModel: Record<string, number>;
  };
  const agent: TestAgent = {
    session: validator,
    missionId: mission.summary.id,
    role: 'validator',
    streaming: false,
    pendingSends: [],
    lastUsedAt: Date.now(),
  };
  mission.summary.kind = 'mission_orchestrator';
  mission.summary.modelId = 'orchestrator-model';
  mission.summary.validatorModelId = 'mission-validator';
  const defaults: TestDefaults = {
    modelId: 'orchestrator-model',
    validatorModelId: 'factory-validator',
    compactionTokenLimitPerModel: {
      'factory-validator': 100_000,
      'mission-validator': 220_000,
    },
  };
  const internals = manager as unknown as {
    visibleContextLimitForAgent: (
      mission: unknown,
      agent: TestAgent,
      defaults: TestDefaults,
    ) => number | undefined;
  };

  assert.equal(internals.visibleContextLimitForAgent(mission, agent, defaults), 220_000);

  mission.summary.validatorModelId = undefined;
  assert.equal(internals.visibleContextLimitForAgent(mission, agent, defaults), 100_000);
});

test('does not treat tool_result as a safe mid-task compaction checkpoint', async () => {
  const { manager, session } = streamHarness(50_000);
  session.limit = 100_000;
  session.usedBeforeStreamEvent = 250_000;
  session.streamEvents = [{ type: 'tool_result', toolName: 'Read', content: 'ok', isError: false }];

  await manager.handle({
    type: 'mission.send',
    missionId: 'app-stream',
    text: 'hello',
    compactionTokenLimit: 100_000,
    compactionTokenLimitPerModel: {},
  });

  assert.equal(session.compactions, 0);
  assert.deepEqual(session.prompts, ['hello']);
});

test('does not auto-compact after the final answer in the same visible turn', async () => {
  const { manager, session } = streamHarness(50_000);
  session.limit = 100_000;
  session.usedAfterStream = 250_000;
  await manager.handle({
    type: 'mission.send',
    missionId: 'app-stream',
    text: 'hello',
    compactionTokenLimit: 100_000,
    compactionTokenLimitPerModel: {},
  });
  assert.equal(session.compactions, 0);
  assert.deepEqual(session.prompts, ['hello']);
});

test('next turn still leaves automatic compaction to the daemon', async () => {
  const { manager, session } = streamHarness(50_000);
  session.limit = 100_000;
  session.usedAfterStream = 250_000;

  await manager.handle({
    type: 'mission.send',
    missionId: 'app-stream',
    text: 'first',
    compactionTokenLimit: 100_000,
    compactionTokenLimitPerModel: {},
  });

  session.usedAfterStream = undefined;
  await manager.handle({
    type: 'mission.send',
    missionId: 'app-stream',
    text: 'second',
    compactionTokenLimit: 100_000,
    compactionTokenLimitPerModel: {},
  });

  assert.equal(session.compactions, 0);
  assert.deepEqual(session.prompts, ['first', 'second']);
  assert.deepEqual(session.callOrder, [
    'compaction:100000',
    'stream:first',
    'compaction:100000',
    'stream:second',
  ]);
});

test('agent send leaves automatic compaction to the daemon even when over budget', async () => {
  const { manager, mission, events } = streamHarness(0);
  const worker = new FakeCompactionSession('worker-full', 103_000);
  worker.limit = 100_000;
  mission.knownSubagents.add(worker.sessionId);
  mission.subagentSettings.set(worker.sessionId, { modelId: 'worker-model' });
  mission.agents.set(worker.sessionId, {
    session: worker,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: false,
    pendingSends: [],
    lastUsedAt: Date.now(),
  });

  await manager.handle({
    type: 'agent.send',
    missionId: mission.summary.id,
    agentSessionId: worker.sessionId,
    text: 'worker turn',
    compactionTokenLimit: 100_000,
    compactionTokenLimitPerModel: { 'worker-model': 100_000 },
  });

  assert.equal(worker.compactions, 0);
  assert.equal(mission.summary.compactionCount ?? 0, 0);
  assert.deepEqual(worker.prompts, ['worker turn']);
  assert.deepEqual(worker.callOrder, ['compaction:100000', 'stream:worker turn']);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'mission.transcript' &&
        event.event.kind === 'status' &&
        event.event.agentSessionId === worker.sessionId &&
        event.event.text === 'Compacting conversation...',
    ),
    false,
  );
});

test('agent sendNow queues during manual worker compaction without interrupting', async () => {
  const { manager, mission } = streamHarness(0);
  const worker = new FakeCompactionSession('worker-compacting', 93_000);
  worker.limit = 100_000;
  worker.usedAfterCompact = 25_000;
  worker.beforeCompact = async () => {
    await manager.handle({
      type: 'agent.sendNow',
      missionId: mission.summary.id,
      agentSessionId: worker.sessionId,
      text: 'urgent steer',
      compactionTokenLimit: 100_000,
      compactionTokenLimitPerModel: { 'worker-model': 100_000 },
    });
  };
  mission.knownSubagents.add(worker.sessionId);
  mission.subagentSettings.set(worker.sessionId, { modelId: 'worker-model' });
  mission.agents.set(worker.sessionId, {
    session: worker,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: false,
    pendingSends: [],
    lastUsedAt: Date.now(),
  });

  await manager.handle({ type: 'session.compact', sessionId: worker.sessionId });

  await waitFor(() => worker.prompts.length === 1);
  assert.equal(worker.compactions, 1);
  assert.equal(worker.interrupts, 0);
  assert.deepEqual(worker.prompts, ['urgent steer']);
});

test('agent interrupt during manual worker compaction clears queue without interrupting', async () => {
  const { manager, mission } = streamHarness(0);
  const worker = new FakeCompactionSession('worker-interrupt-compact', 93_000);
  worker.limit = 100_000;
  worker.usedAfterCompact = 25_000;
  worker.beforeCompact = async () => {
    await manager.handle({
      type: 'agent.send',
      missionId: mission.summary.id,
      agentSessionId: worker.sessionId,
      text: 'queued steer',
      compactionTokenLimit: 100_000,
      compactionTokenLimitPerModel: { 'worker-model': 100_000 },
    });
    await manager.handle({
      type: 'agent.interrupt',
      missionId: mission.summary.id,
      agentSessionId: worker.sessionId,
    });
  };
  mission.knownSubagents.add(worker.sessionId);
  mission.subagentSettings.set(worker.sessionId, { modelId: 'worker-model' });
  mission.agents.set(worker.sessionId, {
    session: worker,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: false,
    pendingSends: [],
    lastUsedAt: Date.now(),
  });

  await manager.handle({ type: 'session.compact', sessionId: worker.sessionId });

  assert.equal(worker.compactions, 1);
  assert.equal(worker.interrupts, 0);
  assert.deepEqual(worker.prompts, []);
});

test('manual worker compaction rekeys and persists a swapped worker', async () => {
  const { manager, mission, events, internals } = streamHarness(0);
  const worker = new FakeCompactionSession('worker-old', 125_000, 'worker-new');
  const swapped = new FakeCompactionSession('worker-new', 25_000);
  const recordedLinks: WorkerHistoryLink[] = [];
  worker.limit = 100_000;
  swapped.limit = 100_000;
  mission.summary.features = [
    {
      id: 'feature-1',
      description: 'Build the worker task',
      status: 'in_progress',
      skillName: '',
      preconditions: [],
      expectedBehavior: [],
      verificationSteps: [],
      workerSessionIds: ['worker-old', 'worker-other'],
      currentWorkerSessionId: 'worker-old',
      completedWorkerSessionId: 'worker-old',
    },
  ];
  mission.knownSubagents.add(worker.sessionId);
  mission.subagentSettings.set(worker.sessionId, { modelId: 'worker-model' });
  mission.subagentToolUseIds.set('tool-1', worker.sessionId);
  mission.agents.set(worker.sessionId, {
    session: worker,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: false,
    pendingSends: [],
    lastUsedAt: Date.now(),
  });
  (
    internals as unknown as {
      history: {
        recordSubagentLink: (
          missionId: string,
          toolUseId: string,
          workerSessionId: string,
          label?: string,
        ) => void;
        subagentLinks: (missionId: string) => WorkerHistoryLink[];
      };
    }
  ).history.recordSubagentLink = (missionId, toolUseId, workerSessionId, label) => {
    recordedLinks.push({ toolUseId, workerSessionId, label });
    assert.equal(missionId, mission.summary.id);
  };
  (
    internals as unknown as {
      history: { subagentLinks: (missionId: string) => WorkerHistoryLink[] };
    }
  ).history.subagentLinks = () => [
    { toolUseId: 'tool-1', workerSessionId: 'worker-old', label: 'builder' },
  ];
  let loadCalls = 0;
  (
    manager as unknown as {
      runtime: { loadSession: (id: string, handlers: unknown) => Promise<FakeCompactionSession> };
    }
  ).runtime = {
    loadSession: async (id: string) => {
      loadCalls += 1;
      assert.equal(id, 'worker-new');
      return swapped;
    },
  };

  await manager.handle({ type: 'session.compact', sessionId: worker.sessionId });

  assert.equal(worker.compactions, 1);
  assert.equal(mission.agents.has('worker-old'), false);
  assert.equal(mission.agents.has('worker-new'), true);
  assert.equal(mission.knownSubagents.has('worker-new'), true);
  assert.equal(mission.subagentSettings.has('worker-new'), true);
  assert.equal(mission.subagentToolUseIds.get('tool-1'), 'worker-new');
  assert.deepEqual(recordedLinks, [
    { toolUseId: 'tool-1', workerSessionId: 'worker-new', label: 'builder' },
  ]);
  assert.deepEqual(mission.summary.features[0].workerSessionIds, ['worker-new', 'worker-other']);
  assert.equal(mission.summary.features[0].currentWorkerSessionId, 'worker-new');
  assert.equal(mission.summary.features[0].completedWorkerSessionId, 'worker-new');
  assert.deepEqual(swapped.prompts, []);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'mission.worker.rekey' &&
        event.oldSessionId === 'worker-old' &&
        event.newSessionId === 'worker-new',
    ),
    true,
  );
  assert.equal(loadCalls, 1);

  await manager.handle({
    type: 'agent.open',
    missionId: mission.summary.id,
    agentSessionId: 'worker-old',
    role: 'worker',
  });
  assert.equal(loadCalls, 1);

  await manager.handle({
    type: 'agent.send',
    missionId: mission.summary.id,
    agentSessionId: 'worker-old',
    text: 'old id follow-up',
    compactionTokenLimit: 100_000,
    compactionTokenLimitPerModel: { 'worker-model': 100_000 },
  });

  assert.deepEqual(swapped.prompts, ['old id follow-up']);
  assert.equal(loadCalls, 1);
});

test('manual worker stale swap preserves the new worker id when reload retry fails', async () => {
  const { manager, mission, internals } = streamHarness(0);
  const worker = new FakeCompactionSession('worker-stale-old', 125_000, 'worker-stale-new');
  const swapped = new FakeCompactionSession('worker-stale-new', 25_000);
  const recordedLinks: WorkerHistoryLink[] = [];
  worker.limit = 100_000;
  swapped.limit = 100_000;
  (swapped as unknown as { initResult: unknown }).initResult = { session: {}, settings: {} };
  mission.summary.features = [
    {
      id: 'feature-stale',
      description: 'Recover the worker task',
      status: 'in_progress',
      skillName: '',
      preconditions: [],
      expectedBehavior: [],
      verificationSteps: [],
      workerSessionIds: ['worker-stale-old'],
      currentWorkerSessionId: 'worker-stale-old',
    },
  ];
  mission.knownSubagents.add(worker.sessionId);
  mission.subagentSettings.set(worker.sessionId, { modelId: 'worker-model' });
  mission.subagentToolUseIds.set('tool-stale', worker.sessionId);
  mission.agents.set(worker.sessionId, {
    session: worker,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: false,
    pendingSends: ['queued after compact'],
    lastUsedAt: Date.now(),
  });
  (
    internals as unknown as {
      history: {
        recordSubagentLink: (
          missionId: string,
          toolUseId: string,
          workerSessionId: string,
          label?: string,
        ) => void;
        subagentLinks: (missionId: string) => WorkerHistoryLink[];
      };
    }
  ).history.recordSubagentLink = (missionId, toolUseId, workerSessionId, label) => {
    recordedLinks.push({ toolUseId, workerSessionId, label });
    assert.equal(missionId, mission.summary.id);
  };
  (
    internals as unknown as {
      history: { subagentLinks: (missionId: string) => WorkerHistoryLink[] };
    }
  ).history.subagentLinks = () => [
    { toolUseId: 'tool-stale', workerSessionId: 'worker-stale-old', label: 'recoverer' },
  ];
  let loadCalls = 0;
  (
    manager as unknown as {
      runtime: { loadSession: (id: string, handlers: unknown) => Promise<FakeCompactionSession> };
    }
  ).runtime = {
    loadSession: async (id: string) => {
      loadCalls += 1;
      assert.equal(id, 'worker-stale-new');
      if (loadCalls <= 2) throw new Error('reload unavailable');
      return swapped;
    },
  };
  let sentDuringClose = false;
  let releaseConcurrentStream: (() => void) | undefined;
  let concurrentSendError: unknown;
  const concurrentStreamStarted = new Promise<void>((resolve) => {
    swapped.beforeStream = async (prompt) => {
      if (prompt !== 'old id during close') return;
      resolve();
      await new Promise<void>((release) => {
        releaseConcurrentStream = release;
      });
    };
  });
  worker.beforeClose = async () => {
    if (sentDuringClose) return;
    sentDuringClose = true;
    void manager
      .handle({
        type: 'agent.send',
        missionId: mission.summary.id,
        agentSessionId: 'worker-stale-old',
        text: 'old id during close',
        compactionTokenLimit: 100_000,
        compactionTokenLimitPerModel: { 'worker-model': 100_000 },
      })
      .catch((err) => {
        concurrentSendError = err;
      });
    await concurrentStreamStarted;
  };

  await manager.handle({ type: 'session.compact', sessionId: worker.sessionId });

  assert.equal(worker.compactions, 1);
  assert.equal(mission.summary.compactionCount, 1);
  assert.equal(sentDuringClose, true);
  assert.equal(loadCalls, 3);
  assert.equal(mission.agents.has('worker-stale-old'), false);
  assert.equal(mission.agents.has('worker-stale-new'), true);
  assert.equal(mission.knownSubagents.has('worker-stale-new'), true);
  assert.equal(mission.subagentSettings.has('worker-stale-new'), true);
  assert.equal(mission.subagentToolUseIds.get('tool-stale'), 'worker-stale-new');
  assert.deepEqual(recordedLinks, [
    { toolUseId: 'tool-stale', workerSessionId: 'worker-stale-new', label: 'recoverer' },
  ]);
  assert.deepEqual(mission.summary.features[0].workerSessionIds, ['worker-stale-new']);
  assert.equal(mission.summary.features[0].currentWorkerSessionId, 'worker-stale-new');
  assert.deepEqual(worker.prompts, []);
  assert.deepEqual(swapped.prompts, ['old id during close']);

  releaseConcurrentStream?.();
  await waitFor(() => swapped.prompts.length === 2);
  assert.equal(concurrentSendError, undefined);
  assert.deepEqual(swapped.prompts, ['old id during close', 'queued after compact']);

  await manager.handle({
    type: 'agent.send',
    missionId: mission.summary.id,
    agentSessionId: 'worker-stale-old',
    text: 'old id follow-up',
    compactionTokenLimit: 100_000,
    compactionTokenLimitPerModel: { 'worker-model': 100_000 },
  });

  assert.deepEqual(swapped.prompts, [
    'old id during close',
    'queued after compact',
    'old id follow-up',
  ]);
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
  (
    manager as unknown as { getFactoryDefaults: () => Promise<Record<string, never>> }
  ).getFactoryDefaults = async () => ({});
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

test('context stats expose the selected visible compaction budget', async () => {
  const { manager, session, mission, events } = streamHarness(93_478);
  mission.summary.modelId = 'model-a';
  session.limit = 90_000;
  session.accuracy = 'estimated';
  const internals = manager as unknown as {
    getFactoryDefaults: () => Promise<{
      modelId?: string;
      compactionTokenLimit?: number;
      compactionTokenLimitPerModel?: Record<string, number>;
    }>;
  };
  internals.getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimit: 100_000,
  });

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: 100_000,
    compactionTokenLimitPerModel: {},
  });
  await manager.handle({ type: 'mission.send', missionId: 'app-stream', text: 'hello' });

  const contextEvent = events.findLast((event) => event.type === 'context.updated') as
    | { type: 'context.updated'; stats: { used: number; remaining: number; limit: number } }
    | undefined;
  assert.equal(contextEvent?.stats.used, 93_478);
  assert.equal(contextEvent?.stats.remaining, 6_522);
  assert.equal(contextEvent?.stats.limit, 100_000);
  assert.equal(mission.summary.maxContextTokens, 100_000);
});

test('context stats use the mode default model for visible limits', async () => {
  const { manager, session, mission, events } = streamHarness(125_000);
  mission.summary.kind = 'spec';
  mission.summary.modelId = undefined;
  session.limit = 300_000;
  const internals = manager as unknown as {
    getFactoryDefaults: () => Promise<{
      modelId?: string;
      specModelId?: string;
      compactionTokenLimitPerModel?: Record<string, number>;
    }>;
  };
  internals.getFactoryDefaults = async () => ({
    modelId: 'chat-default',
    specModelId: 'spec-default',
    compactionTokenLimitPerModel: {
      'chat-default': 100_000,
      'spec-default': 220_000,
    },
  });

  await manager.handle({ type: 'mission.send', missionId: 'app-stream', text: 'hello' });

  const contextEvent = events.findLast((event) => event.type === 'context.updated') as
    | { type: 'context.updated'; stats: { used: number; remaining: number; limit: number } }
    | undefined;
  assert.equal(contextEvent?.stats.used, 125_000);
  assert.equal(contextEvent?.stats.remaining, 95_000);
  assert.equal(contextEvent?.stats.limit, 220_000);
  assert.equal(mission.summary.maxContextTokens, 220_000);
});

test('token usage events preserve the visible context window between refreshes', async () => {
  const { manager, session, mission, events } = streamHarness(92_000);
  mission.summary.modelId = 'model-a';
  mission.summary.maxContextTokens = 100_000;
  session.limit = 90_000;
  session.streamEvents.push({
    type: 'session_token_usage_changed',
    inclusiveTokenUsage: { inputTokens: 1_000, outputTokens: 100 },
    lastCallTokenUsage: { inputTokens: 92_000 },
  });
  const internals = manager as unknown as {
    cachedModels?: ModelInfo[];
    getFactoryDefaults: () => Promise<Record<string, never>>;
  };
  internals.cachedModels = [
    {
      id: 'model-a',
      displayName: 'Model A',
      isDefault: true,
      isCustom: false,
      supportedReasoningEfforts: [],
      maxContextTokens: 200_000,
    },
  ];
  internals.getFactoryDefaults = async () => ({});

  await manager.handle({ type: 'mission.send', missionId: 'app-stream', text: 'hello' });

  const contextEvents = events.filter((event) => event.type === 'context.updated') as Array<{
    type: 'context.updated';
    stats: { used: number; remaining: number; limit: number };
  }>;
  assert.ok(contextEvents.length > 0);
  assert.equal(
    contextEvents.every((event) => event.stats.limit === 100_000),
    true,
  );
  assert.equal(mission.summary.maxContextTokens, 100_000);
});

test('token usage events preserve Factory default visible limits after reset', async () => {
  const { manager, mission, events } = streamHarness(92_000);
  mission.summary.modelId = 'model-a';
  mission.summary.maxContextTokens = 200_000;
  const internals = manager as unknown as {
    cachedModels?: ModelInfo[];
    getFactoryDefaults: () => Promise<{
      modelId?: string;
      compactionTokenLimit?: number;
    }>;
    contextSnapshots: Map<string, unknown>;
    applyNormalized: (
      missionId: string,
      event: { tokens: { tokensIn: number; tokensOut: number; contextTokens?: number } },
    ) => void;
  };
  internals.cachedModels = [
    {
      id: 'model-a',
      displayName: 'Model A',
      isDefault: true,
      isCustom: false,
      supportedReasoningEfforts: [],
      maxContextTokens: 1_000_000,
    },
  ];
  internals.getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimit: 400_000,
  });

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: 200_000,
    compactionTokenLimitPerModel: {},
  });
  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: 'factory-default',
    compactionTokenLimitPerModel: {},
  });
  internals.contextSnapshots.clear();

  internals.applyNormalized('app-stream', {
    tokens: { tokensIn: 1_000, tokensOut: 50, contextTokens: 390_000 },
  });

  const contextEvent = events.findLast((event) => event.type === 'context.updated') as
    | { type: 'context.updated'; stats: { used: number; remaining: number; limit: number } }
    | undefined;
  const tokenEvent = events.findLast((event) => event.type === 'mission.tokens') as
    | { type: 'mission.tokens'; maxContextTokens?: number }
    | undefined;
  assert.equal(contextEvent?.stats.used, 390_000);
  assert.equal(contextEvent?.stats.remaining, 10_000);
  assert.equal(contextEvent?.stats.limit, 400_000);
  assert.equal(tokenEvent?.maxContextTokens, 400_000);
  assert.equal(mission.summary.maxContextTokens, 400_000);
});

test('token usage events preserve Factory per-model visible limits after reset', async () => {
  const { manager, mission, events } = streamHarness(92_000);
  mission.summary.modelId = 'model-a';
  mission.summary.maxContextTokens = 200_000;
  const internals = manager as unknown as {
    cachedModels?: ModelInfo[];
    getFactoryDefaults: () => Promise<{
      modelId?: string;
      compactionTokenLimitPerModel?: Record<string, number>;
    }>;
    contextSnapshots: Map<string, unknown>;
    applyNormalized: (
      missionId: string,
      event: { tokens: { tokensIn: number; tokensOut: number; contextTokens?: number } },
    ) => void;
  };
  internals.cachedModels = [
    {
      id: 'model-a',
      displayName: 'Model A',
      isDefault: true,
      isCustom: false,
      supportedReasoningEfforts: [],
      maxContextTokens: 1_000_000,
    },
  ];
  internals.getFactoryDefaults = async () => ({
    modelId: 'model-a',
    compactionTokenLimitPerModel: { 'model-a': 400_000 },
  });

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimitPerModel: { 'model-a': 200_000 },
  });
  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: 'factory-default',
    compactionTokenLimitPerModel: {},
  });
  internals.contextSnapshots.clear();

  internals.applyNormalized('app-stream', {
    tokens: { tokensIn: 1_000, tokensOut: 50, contextTokens: 390_000 },
  });

  const contextEvent = events.findLast((event) => event.type === 'context.updated') as
    | { type: 'context.updated'; stats: { used: number; remaining: number; limit: number } }
    | undefined;
  const tokenEvent = events.findLast((event) => event.type === 'mission.tokens') as
    | { type: 'mission.tokens'; maxContextTokens?: number }
    | undefined;
  assert.equal(contextEvent?.stats.used, 390_000);
  assert.equal(contextEvent?.stats.remaining, 10_000);
  assert.equal(contextEvent?.stats.limit, 400_000);
  assert.equal(tokenEvent?.maxContextTokens, 400_000);
  assert.equal(mission.summary.maxContextTokens, 400_000);
});

test('cleared compaction limit returns the visible context window to the model max', async () => {
  const { manager, session, mission, events } = streamHarness(92_000);
  mission.summary.modelId = 'model-a';
  mission.summary.maxContextTokens = 100_000;
  session.streamEvents.push({
    type: 'session_token_usage_changed',
    inclusiveTokenUsage: { inputTokens: 1_000, outputTokens: 100 },
    lastCallTokenUsage: { inputTokens: 92_000 },
  });
  const internals = manager as unknown as {
    cachedModels?: ModelInfo[];
    getFactoryDefaults: () => Promise<Record<string, never>>;
  };
  internals.cachedModels = [
    {
      id: 'model-a',
      displayName: 'Model A',
      isDefault: true,
      isCustom: false,
      supportedReasoningEfforts: [],
      maxContextTokens: 200_000,
    },
  ];
  internals.getFactoryDefaults = async () => ({});

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: null,
    compactionTokenLimitPerModel: {},
  });
  await manager.handle({ type: 'mission.send', missionId: 'app-stream', text: 'hello' });

  const contextEvent = events.findLast((event) => event.type === 'context.updated') as
    | { type: 'context.updated'; stats: { limit: number } }
    | undefined;
  assert.equal(contextEvent?.stats.limit, 200_000);
  assert.equal(mission.summary.maxContextTokens, 200_000);
});

test('cleared per-model compaction limit returns the visible context window to the model max', async () => {
  const { manager, mission, events } = streamHarness(92_000);
  mission.summary.modelId = 'model-a';
  mission.summary.maxContextTokens = 100_000;
  const internals = manager as unknown as {
    cachedModels?: ModelInfo[];
    getFactoryDefaults: () => Promise<Record<string, never>>;
  };
  internals.cachedModels = [
    {
      id: 'model-a',
      displayName: 'Model A',
      isDefault: true,
      isCustom: false,
      supportedReasoningEfforts: [],
      maxContextTokens: 200_000,
    },
  ];
  internals.getFactoryDefaults = async () => ({});

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimitPerModel: { 'model-a': 100_000 },
  });
  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimitPerModel: {},
  });
  await manager.handle({ type: 'mission.send', missionId: 'app-stream', text: 'hello' });

  const contextEvent = events.findLast((event) => event.type === 'context.updated') as
    | { type: 'context.updated'; stats: { limit: number } }
    | undefined;
  assert.equal(contextEvent?.stats.limit, 200_000);
  assert.equal(mission.summary.maxContextTokens, 200_000);
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

test('rejects manual compaction while a live agent is streaming', async () => {
  const { manager, mission, events } = streamHarness(10_000);
  const agentSession = new FakeCompactionSession('worker-active', 10_000);
  mission.agents.set(agentSession.sessionId, {
    session: agentSession,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: true,
    pendingSends: [],
    lastUsedAt: Date.now(),
  });

  await manager.handle({ type: 'session.compact', sessionId: agentSession.sessionId });

  assert.equal(agentSession.compactions, 0);
  assert.equal(
    events.some(
      (e) =>
        e.type === 'mission.transcript' &&
        e.event.kind === 'status' &&
        e.event.agentSessionId === agentSession.sessionId &&
        /cannot compact/i.test(e.event.text ?? ''),
    ),
    true,
  );
});

test('manual compaction of an idle live agent rekeys the live worker session', async () => {
  const { manager, mission, internals } = streamHarness(10_000);
  const oldWorker = new FakeCompactionSession('worker-old', 10_000, 'worker-new');
  const newWorker = new FakeCompactionSession('worker-new', 4_000);
  mission.agents.set(oldWorker.sessionId, {
    session: oldWorker,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: false,
    compacting: false,
    pendingSends: [],
    lastUsedAt: Date.now(),
  });
  mission.knownSubagents.add(oldWorker.sessionId);
  (
    internals as typeof internals & {
      runtime: { loadSession: (id: string, handlers: unknown) => Promise<FakeCompactionSession> };
    }
  ).runtime = {
    loadSession: async () => newWorker,
  };

  await manager.handle({ type: 'session.compact', sessionId: oldWorker.sessionId });

  assert.equal(oldWorker.compactions, 1);
  assert.equal(mission.agents.has(oldWorker.sessionId), false);
  assert.equal(mission.agents.get(newWorker.sessionId)?.session, newWorker);

  await manager.handle({
    type: 'agent.send',
    missionId: mission.summary.id,
    agentSessionId: oldWorker.sessionId,
    text: 'after worker compact',
  });

  await waitFor(() => newWorker.prompts.includes('after worker compact'));
  assert.equal(newWorker.prompts.includes('after worker compact'), true);
  assert.equal(oldWorker.prompts.includes('after worker compact'), false);
});

test('rejects parent mission compaction while a live agent is streaming', async () => {
  const { manager, session, mission, events } = streamHarness(10_000);
  const agentSession = new FakeCompactionSession('worker-active-parent', 10_000);
  mission.agents.set(agentSession.sessionId, {
    session: agentSession,
    missionId: mission.summary.id,
    role: 'worker',
    streaming: true,
    pendingSends: [],
    lastUsedAt: Date.now(),
  });

  await manager.handle({ type: 'mission.compact', missionId: mission.summary.id });

  assert.equal(session.compactions, 0);
  assert.equal(agentSession.compactions, 0);
  assert.equal(
    events.some(
      (e) =>
        e.type === 'mission.transcript' &&
        e.event.kind === 'status' &&
        e.event.agentSessionId === agentSession.sessionId &&
        /cannot compact/i.test(e.event.text ?? ''),
    ),
    true,
  );
});

test('manual in-place compaction refreshes daemon settings before next send', async () => {
  const { manager, session, mission } = streamHarness(10_000);

  await manager.handle({ type: 'mission.compact', missionId: mission.summary.id });
  await manager.handle({
    type: 'mission.send',
    missionId: mission.summary.id,
    text: 'after in-place compact',
    compactionTokenLimit: 180_000,
    compactionTokenLimitPerModel: {},
  });

  assert.equal(session.compactions, 1);
  assert.equal(mission.summary.compactionCount, 1);
  assert.equal(session.callOrder.includes('compaction:180000'), true);
  assert.equal(session.callOrder.includes('stream:after in-place compact'), true);
  assert.equal(
    session.callOrder.indexOf('compaction:180000') <
      session.callOrder.indexOf('stream:after in-place compact'),
    true,
  );
});

test('manual in-place compaction refreshes daemon settings before queued send drains', async () => {
  const { manager, session, mission } = streamHarness(10_000);
  session.beforeCompact = () =>
    manager.handle({
      type: 'mission.send',
      missionId: mission.summary.id,
      text: 'queued during compact',
      compactionTokenLimit: 180_000,
      compactionTokenLimitPerModel: {},
    });

  await manager.handle({ type: 'mission.compact', missionId: mission.summary.id });

  assert.equal(session.compactions, 1);
  assert.equal(mission.summary.compactionCount, 1);
  assert.equal(session.callOrder.includes('compaction:180000'), true);
  assert.equal(session.callOrder.includes('stream:queued during compact'), true);
  assert.equal(
    session.callOrder.indexOf('compaction:180000') <
      session.callOrder.indexOf('stream:queued during compact'),
    true,
  );
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
    getFactoryDefaults: () => Promise<{ modelId?: string; compactionTokenLimit?: number }>;
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
  internals.getFactoryDefaults = async () => ({});
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

test('manual compaction swap reapplies current live compaction settings', async () => {
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

  await manager.handle({
    type: 'settings.compaction.update',
    compactionTokenLimit: 200_000,
    compactionTokenLimitPerModel: { 'default-model': 175_000 },
  });
  await manager.handle({ type: 'mission.compact', missionId: 'app-swap' });

  assert.deepEqual(swapped.settingsUpdates.at(-1), {
    compactionTokenLimit: 175_000,
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
