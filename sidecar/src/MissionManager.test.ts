import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampCompactionTokenLimit,
  compactionTokenLimitForModel,
  createAutonomyForCommand,
  createCompactionSettingsForModel,
  createMissionAgentDefaultsForMode,
  createModelDefaultsForMode,
  createSessionSettingsForAgent,
  MissionManager,
  startupFactoryDefaults,
  validateFactoryDefaults,
} from './MissionManager.js';
import type { MissionSummary, ModelInfo, ServerEvent } from './protocol.js';

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

  async getContextStats(): Promise<{ used: number; remaining: number; limit: number; accuracy: 'exact'; updatedAt: string }> {
    return { used: 0, remaining: 100_000, limit: 100_000, accuracy: 'exact', updatedAt: new Date().toISOString() };
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
    createModelDefaultsForMode('agi', {}, {
      modelId: 'default-model',
      reasoningEffort: 'medium',
      missionOrchestratorModelId: 'mission-model',
      missionOrchestratorReasoningEffort: 'high',
    }),
    { modelId: 'mission-model', reasoningEffort: 'high' },
  );
});

test('uses regular session defaults for normal chat', () => {
  assert.deepEqual(
    createModelDefaultsForMode('auto', {}, {
      modelId: 'default-model',
      reasoningEffort: 'medium',
      missionOrchestratorModelId: 'mission-model',
      missionOrchestratorReasoningEffort: 'high',
    }),
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
    createMissionAgentDefaultsForMode('agi', {
      workerModel: 'worker-custom',
      workerReasoning: 'low',
    }, defaults),
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
    createCompactionSettingsForModel('model-a', { compactionTokenLimit: null, compactionTokenLimitPerModel: {} }, {}, 100_000),
    {},
  );
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
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
  };
  const internals = manager as unknown as {
    history: { recordEvent: () => void; syncSummaries: () => void };
    missions: Map<string, typeof mission>;
  };
  internals.history = { recordEvent: () => {}, syncSummaries: () => {} };
  internals.missions.set(mission.summary.id, mission);

  const firstTurn = manager.handle({ type: 'mission.send', missionId: mission.summary.id, text: 'first' });
  await waitFor(() => session.prompts.includes('first'));

  await manager.handle({ type: 'mission.send', missionId: mission.summary.id, text: 'queued' });
  await manager.handle({ type: 'mission.sendNow', missionId: mission.summary.id, text: 'now' });

  await waitFor(() => session.prompts.length >= 3);
  await firstTurn;

  assert.equal(session.interrupts, 1);
  assert.deepEqual(session.prompts, ['first', 'now', 'queued']);
  assert.equal(mission.pendingSends.length, 0);
  assert.equal(events.some((event) => event.type === 'mission.error' || event.type === 'error'), false);
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
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
  };
  const internals = manager as unknown as {
    history: { recordEvent: () => void; syncSummaries: () => void };
    missions: Map<string, typeof mission>;
  };
  internals.history = { recordEvent: () => {}, syncSummaries: () => {} };
  internals.missions.set(mission.summary.id, mission);

  const designPrompt = 'Design Mode reference pack:\n- URL: about:blank\n\nUser instruction:\nMake the hero cleaner';

  // First normal turn (flag uninitialized) must still call updateSettings to
  // ensure TodoWrite is enabled — the session might have it disabled from a
  // prior design turn before the in-memory flag was lost to a page reload.
  await manager.handle({ type: 'mission.send', missionId: mission.summary.id, text: 'just a normal question' });
  await waitFor(() => session.prompts.includes('just a normal question'));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: [] });

  // Design turn disables TodoWrite.
  await manager.handle({ type: 'mission.send', missionId: mission.summary.id, text: designPrompt });
  await waitFor(() => session.prompts.includes(designPrompt));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: ['TodoWrite'] });

  // Normal turn restores it.
  await manager.handle({ type: 'mission.send', missionId: mission.summary.id, text: 'another normal one' });
  await waitFor(() => session.prompts.includes('another normal one'));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: [] });

  // A second design turn re-disables it after the normal turn restored it.
  await manager.handle({ type: 'mission.send', missionId: mission.summary.id, text: `${designPrompt} again` });
  await waitFor(() => session.prompts.includes(`${designPrompt} again`));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: ['TodoWrite'] });
  assert.equal(events.some((event) => event.type === 'mission.error' || event.type === 'error'), false);
});

test('does not emit live compaction disable payloads', () => {
  assert.deepEqual(
    createCompactionSettingsForModel('model-a', { compactionTokenLimit: null, compactionTokenLimitPerModel: {} }),
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
    createSessionSettingsForAgent(
      'orchestrator',
      {
        modelId: 'model-b',
      },
    ),
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
    startupFactoryDefaults({
      modelId: 'missing-model',
      reasoningEffort: 'high',
      compactionModel: 'missing-model',
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: { 'missing-model': 150_000 },
      autonomy: 'high',
      interactionMode: 'auto',
      workerModelId: 'missing-worker',
    }, []),
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
    validateFactoryDefaults({
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
    }, models),
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
    validateFactoryDefaults({
      modelId: 'saved-model',
      reasoningEffort: 'high',
      specModelId: 'saved-spec-model',
      workerModelId: 'saved-worker',
      validatorModelId: 'saved-validator',
      compactionModel: 'saved-compaction-model',
      compactionTokenLimit: 200_000.9,
      compactionTokenLimitPerModel: { 'saved-model': 150_000.5 },
    }, []),
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
  settingsUpdates: Array<Record<string, unknown>> = [];

  constructor(readonly sessionId: string, private used: number) {}

  async *stream(prompt: string): AsyncGenerator<never, void, undefined> {
    this.prompts.push(prompt);
  }

  async updateSettings(params: Record<string, unknown>): Promise<void> {
    this.settingsUpdates.push(params);
  }

  async getContextStats(): Promise<{ used: number; remaining: number; limit: number; accuracy: 'exact'; updatedAt: string }> {
    return { used: this.used, remaining: Math.max(0, 1_000_000 - this.used), limit: 1_000_000, accuracy: 'exact', updatedAt: new Date().toISOString() };
  }

  async compactSession(): Promise<{ newSessionId: string; removedCount: number }> {
    this.compactions += 1;
    return { newSessionId: this.sessionId, removedCount: 4 };
  }
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
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    effectiveCompactionTokenLimit: effectiveCompactionTokenLimit,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenDroidSessionIds: () => Set<string>;
    };
    missions: Map<string, typeof mission>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenDroidSessionIds: () => new Set(),
  };
  internals.missions.set(mission.summary.id, mission);
  return { manager, session, events, mission };
}

test('auto-compacts an idle turn once context crosses the effective limit', async () => {
  const { manager, session, events } = autoCompactHarness(250_000, 200_000);
  await manager.handle({ type: 'mission.send', missionId: 'app-compact', text: 'hello' });
  assert.equal(session.compactions, 1);
  assert.equal(events.some((event) => event.type === 'mission.error' || event.type === 'error'), false);
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

test('rejects manual compaction while streaming', async () => {
  const { manager, mission, events } = autoCompactHarness(250_000, 200_000);
  mission.streaming = true;
  await manager.handle({ type: 'mission.compact', missionId: 'app-compact', customInstructions: undefined });
  assert.equal(mission.streaming, true);
  const hasRejection = events.some((e) => e.type === 'mission.transcript' && /cannot compact/i.test((e as { event?: { text?: string } }).event?.text ?? ''));
  assert.equal(hasRejection, true);
});
