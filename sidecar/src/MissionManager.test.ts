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
    compacting: false,
  };
  const internals = manager as unknown as {
    history: { recordEvent: () => void; syncSummaries: () => void; recordSubagentLink: () => void; subagentLinks: () => []; };
    missions: Map<string, typeof mission>;
  };
  internals.history = { recordEvent: () => {}, syncSummaries: () => {}, recordSubagentLink: () => {}, subagentLinks: () => [] };
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
    subagentToolUseIds: new Map(),
    subagentSettings: new Map(),
    pendingSubagents: [],
    mcpServers: [],
    compacting: true,
  };
  const internals = manager as unknown as {
    history: { recordEvent: () => void; syncSummaries: () => void; recordSubagentLink: () => void; subagentLinks: () => []; };
    missions: Map<string, typeof mission>;
  };
  internals.history = { recordEvent: () => {}, syncSummaries: () => {}, recordSubagentLink: () => {}, subagentLinks: () => [] };
  internals.missions.set(mission.summary.id, mission);

  // Manual compaction (compacting=true, streaming=false): must not drive() concurrently.
  await manager.handle({ type: 'mission.sendNow', missionId: mission.summary.id, text: 'steer-manual' });
  assert.deepEqual(session.prompts, []);
  assert.equal(session.interrupts, 0);

  // Auto-compaction (compacting=true, streaming=true): must not interrupt the compaction.
  mission.streaming = true;
  await manager.handle({ type: 'mission.sendNow', missionId: mission.summary.id, text: 'steer-auto' });
  assert.equal(session.interrupts, 0);

  // Both steers are preserved at the front of the queue for delivery after compaction.
  assert.deepEqual(mission.pendingSends, ['steer-auto', 'steer-manual']);
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
    compacting: false,
  };
  const internals = manager as unknown as {
    history: { recordEvent: () => void; syncSummaries: () => void; recordSubagentLink: () => void; subagentLinks: () => []; };
    missions: Map<string, typeof mission>;
  };
  internals.history = { recordEvent: () => {}, syncSummaries: () => {}, recordSubagentLink: () => {}, subagentLinks: () => [] };
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
  failCompaction = false;
  settingsUpdates: Array<Record<string, unknown>> = [];

  constructor(readonly sessionId: string, private used: number, private swapTo?: string) {}

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

test('auto-compacts an idle turn once context crosses the effective limit', async () => {
  const { manager, session, events } = autoCompactHarness(250_000, 200_000);
  await manager.handle({ type: 'mission.send', missionId: 'app-compact', text: 'hello' });
  assert.equal(session.compactions, 1);
  assert.equal(events.some((event) => event.type === 'mission.error' || event.type === 'error'), false);
});

test('compaction failure surfaces a recoverable error and terminal status without failing the mission', async () => {
  const { manager, session, events } = autoCompactHarness(250_000, 200_000);
  session.failCompaction = true;
  await manager.handle({ type: 'mission.send', missionId: 'app-compact', text: 'hello' });
  // Recoverable: a toast error is emitted but the mission is not marked failed.
  assert.equal(events.some((e) => e.type === 'mission.error'), false);
  assert.equal(events.some((e) => e.type === 'error' && /could not compact session/i.test((e as { message?: string }).message ?? '')), true);
  // A terminal status clears the in-progress "Compacting..." shimmer.
  assert.equal(
    events.some((e) => e.type === 'mission.transcript' && /could not finish/i.test((e as { event?: { text?: string } }).event?.text ?? '')),
    true,
  );
});

test('Stop during compaction drops queued sends but does not interrupt the compaction', async () => {
  const { manager, session, mission } = autoCompactHarness(0, undefined);
  mission.compacting = true;
  let interrupts = 0;
  (session as unknown as { interrupt: () => Promise<void> }).interrupt = async () => { interrupts += 1; };
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

test('rejects manual compaction while streaming', async () => {
  const { manager, mission, events } = autoCompactHarness(250_000, 200_000);
  mission.streaming = true;
  await manager.handle({ type: 'mission.compact', missionId: 'app-compact', customInstructions: undefined });
  assert.equal(mission.streaming, true);
  const hasRejection = events.some((e) => e.type === 'mission.transcript' && /cannot compact/i.test((e as { event?: { text?: string } }).event?.text ?? ''));
  assert.equal(hasRejection, true);
});

function workerAutoCompactHarness(workerUsed: number, workerLimit?: number, swapTo?: string) {
  const { manager, session: orchestratorSession, events, mission } = autoCompactHarness(0, undefined);
  const workerSession = new FakeCompactionSession('worker-compact', workerUsed, swapTo);
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
  return { manager, events, mission, workerSession, orchestratorSession };
}

test('worker auto-compacts its own session in place once context crosses the worker limit', async () => {
  const { manager, events, workerSession, orchestratorSession } = workerAutoCompactHarness(250_000, 200_000);
  await manager.handle({ type: 'agent.send', missionId: 'app-compact', agentSessionId: 'worker-compact', text: 'go' });
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
  assert.equal(events.some((e) => e.type === 'mission.error' || e.type === 'error'), false);
});

test('worker does not auto-compact while under its limit', async () => {
  const { manager, workerSession } = workerAutoCompactHarness(150_000, 200_000);
  await manager.handle({ type: 'agent.send', missionId: 'app-compact', agentSessionId: 'worker-compact', text: 'go' });
  assert.equal(workerSession.compactions, 0);
});

test('worker does not auto-compact when its effective limit is unset', async () => {
  const { manager, workerSession } = workerAutoCompactHarness(250_000, undefined);
  await manager.handle({ type: 'agent.send', missionId: 'app-compact', agentSessionId: 'worker-compact', text: 'go' });
  assert.equal(workerSession.compactions, 0);
});

test('worker compaction fails loudly instead of trusting a swapped backing session', async () => {
  const { manager, events, mission } = workerAutoCompactHarness(250_000, 200_000, 'worker-swapped');
  await manager.handle({ type: 'agent.send', missionId: 'app-compact', agentSessionId: 'worker-compact', text: 'go' });
  // The stale worker is closed (removed) rather than left usable with a session
  // the daemon swapped out from under us.
  assert.equal(mission.agents.has('worker-compact'), false);
  // The swap surfaces as an error rather than a silent "complete".
  assert.equal(events.some((e) => e.type === 'error' && /new backing session/i.test((e as { message?: string }).message ?? '')), true);
  const completed = events.some(
    (e) =>
      e.type === 'mission.transcript' &&
      /Compaction complete/i.test((e as { event?: { text?: string } }).event?.text ?? ''),
  );
  assert.equal(completed, false);
});

test('stale worker swap preserves queued sends as recoverable instead of replaying to the old id', async () => {
  const { manager, events, mission, workerSession } = workerAutoCompactHarness(250_000, 200_000, 'worker-swapped');
  const agent = mission.agents.get('worker-compact') as { pendingSends: string[] };
  agent.pendingSends.push('queued-during-compaction');
  await manager.handle({ type: 'agent.send', missionId: 'app-compact', agentSessionId: 'worker-compact', text: 'go' });
  // The stale worker is closed.
  assert.equal(mission.agents.has('worker-compact'), false);
  // The queued send is never replayed to the now-stale session id...
  assert.equal(workerSession.prompts.includes('queued-during-compaction'), false);
  // ...it is surfaced as a recoverable error so it can be resent.
  assert.equal(
    events.some(
      (e) =>
        e.type === 'error' &&
        /queued-during-compaction/.test((e as { message?: string }).message ?? '') &&
        /resent/i.test((e as { message?: string }).message ?? ''),
    ),
    true,
  );
});

test('transient worker compaction failure keeps the session and drains queued sends', async () => {
  const { manager, mission, workerSession } = workerAutoCompactHarness(250_000, 200_000);
  workerSession.failCompaction = true;
  const agent = mission.agents.get('worker-compact') as { pendingSends: string[] };
  agent.pendingSends.push('queued-after');
  await manager.handle({ type: 'agent.send', missionId: 'app-compact', agentSessionId: 'worker-compact', text: 'go' });
  // A transient failure must not close the worker...
  assert.equal(mission.agents.has('worker-compact'), true);
  // ...and must not drop the queued send (it drains on a fresh turn).
  await waitFor(() => workerSession.prompts.includes('queued-after'));
  assert.equal(workerSession.prompts.includes('queued-after'), true);
});
