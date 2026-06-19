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
  resumedCompactionTokenLimit,
} from './compaction.js';
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
  constructor(readonly sessionId: string) {}
  onNotification(cb: (note: Record<string, unknown>) => void): () => void {
    this.notify = cb;
    return () => {
      this.notify = undefined;
    };
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
    rekeyAgentSession: (a: typeof agent, newId: string) => Promise<void>;
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

  await internals.rekeyAgentSession(agent, 'worker-new');

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
    compactAgent: (a: typeof agent, t: 'auto' | 'manual') => Promise<string>;
  };
  internals.runtime = { loadSession: async () => newSession };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    subagentLinks: () => [{ workerSessionId: 'worker-old', toolUseId: 'tool-cmp' }],
    recordSubagentLink: () => {},
  };
  internals.missions.set('app-cmp', mission);

  const outcome = await internals.compactAgent(agent, 'auto');

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
    rekeyAgentSession: (a: typeof agent, newId: string) => Promise<void>;
  };
  internals.runtime = { loadSession: async () => newSession };
  internals.history = { subagentLinks: () => [], recordSubagentLink: () => {} };
  internals.missions.set('app-feat', mission);

  await internals.rekeyAgentSession(agent, 'worker-new');

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
  // ...and it never streamed into the dead old session.
  assert.equal(session.prompts.includes('queued-after-recovery'), false);
  assert.equal(session.prompts.includes('go'), true);
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
