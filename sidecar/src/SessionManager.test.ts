import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAutonomyForCommand,
  createMissionAgentDefaultsForMode,
  createModelDefaultsForMode,
  createSessionSettingsForAgent,
  SessionManager,
  startupFactoryDefaults,
  validateFactoryDefaults,
} from './SessionManager.js';
import {
  clampCompactionTokenLimit,
  compactionTriggerCeiling,
  compactionTokenLimitForModel,
  effectiveCompactionTriggerLimit,
  daemonDefaultCompactionTokenLimit,
  daemonCompactionSettings,
  resolvedCompactionTokenLimit,
  resumedCompactionTokenLimit,
} from './compaction.js';
import type {
  SessionSummary,
  ModelInfo,
  ServerEvent,
  ChildSessionHistoryLink,
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

function testSummary(id: string, sessionId: string): SessionSummary {
  const now = Date.now();
  return {
    appSessionId: id,
    providerSessionId: sessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
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

test('uses Mission Control orchestrator defaults for Mission Control sessions', () => {
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

test('derives the armed trigger from the UI snapshot (per-model over global)', () => {
  assert.equal(
    effectiveCompactionTriggerLimit({
      modelId: 'model-a',
      ui: {
        compactionTokenLimit: 200_000,
        compactionTokenLimitPerModel: { 'model-a': 150_000 },
      },
    }),
    150_000,
  );
});

test('caps Droid compaction limits below the model context window with headroom', () => {
  // The trigger never reaches the full window: it is capped at
  // COMPACTION_WINDOW_FRACTION (80%) so the daemon can still run the next
  // provider call and the compaction turn itself before the window overflows.
  assert.equal(compactionTriggerCeiling(100_000), 80_000);
  assert.equal(compactionTriggerCeiling(undefined), undefined);
  // Never rounds down to an invalid zero trigger.
  assert.equal(compactionTriggerCeiling(1), 1);
  assert.equal(clampCompactionTokenLimit(200_000, 100_000), 80_000);
  assert.equal(clampCompactionTokenLimit(80_000, 200_000), 80_000);
  assert.equal(clampCompactionTokenLimit(200_000), 200_000);
  assert.equal(
    effectiveCompactionTriggerLimit({
      modelId: 'model-a',
      ui: { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-a': 150_000 } },
      maxContextTokens: 100_000,
    }),
    80_000,
  );
});

test('matches the daemon model-default compaction threshold', () => {
  assert.equal(daemonDefaultCompactionTokenLimit(), 250_000);
  assert.equal(daemonDefaultCompactionTokenLimit(1_000_000), 250_000);
  assert.equal(daemonDefaultCompactionTokenLimit(180_000), 180_000);
});

test('cleared limits fall back to the daemon model default, still with headroom', () => {
  assert.equal(
    effectiveCompactionTriggerLimit({
      modelId: 'model-a',
      ui: { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
      maxContextTokens: 100_000,
    }),
    80_000,
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

test('a UI settings snapshot outranks session-exposed limits and CLI defaults', () => {
  // Per-model UI override wins for its model...
  assert.equal(
    resolvedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-a': 120_000 } },
      { compactionTokenLimit: 400_000 },
      { compactionTokenLimit: 300_000 },
    ),
    120_000,
  );
  // ...while other models follow the UI's global limit.
  assert.equal(
    resolvedCompactionTokenLimit(
      'model-b',
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-a': 120_000 } },
      { compactionTokenLimit: 400_000 },
      { compactionTokenLimit: 300_000 },
    ),
    200_000,
  );
});

test('a UI-cleared global limit yields the daemon default instead of CLI defaults', () => {
  assert.equal(
    resolvedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
      {},
      { compactionTokenLimit: 300_000, compactionTokenLimitPerModel: { 'model-a': 150_000 } },
    ),
    undefined,
  );
});

test('an explicit per-model map suppresses cleared CLI per-model overrides', () => {
  assert.equal(
    resolvedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimitPerModel: {} },
      { compactionTokenLimit: 210_000 },
      { compactionTokenLimit: 300_000, compactionTokenLimitPerModel: { 'model-a': 150_000 } },
    ),
    210_000,
  );
});

test('without any UI signal the resolver follows exposed limits, then CLI defaults', () => {
  assert.equal(
    resolvedCompactionTokenLimit('model-a', {}, { compactionTokenLimit: 400_000 }, {}),
    400_000,
  );
  assert.equal(
    resolvedCompactionTokenLimit(
      'model-a',
      {},
      {},
      { compactionTokenLimitPerModel: { 'model-a': 175_000 } },
    ),
    175_000,
  );
});

test('withLiveWorkerStatus annotates live links and leaves historical/unknown ones untouched', () => {
  const manager = new SessionManager(() => {});
  const liveSession = {
    summary: testSummary('app-live', 'droid-live'),
    knownChildSessions: new Set(['run-1', 'done-1']),
    completedChildSessions: new Set(['done-1']),
    // A resumed worker the user has opened is live in childSessions but not in
    // knownChildSessions (which only a live spawn populates).
    childSessions: new Map<string, unknown>([['open-1', {}]]),
  };
  const internals = manager as unknown as {
    sessions: Map<string, typeof liveSession>;
    withLiveWorkerStatus: (
      id: string,
      links: ChildSessionHistoryLink[],
    ) => ChildSessionHistoryLink[];
  };
  internals.sessions.set(liveSession.summary.appSessionId, liveSession);
  const out = internals.withLiveWorkerStatus(liveSession.summary.appSessionId, [
    { providerSessionId: 'run-1', toolUseId: 't1' },
    { providerSessionId: 'done-1', toolUseId: 't2' },
    { providerSessionId: 'open-1', toolUseId: 't3' },
    { providerSessionId: 'gone-1', toolUseId: 't4' },
  ]);
  assert.equal(out.find((l) => l.providerSessionId === 'run-1')?.status, 'running');
  assert.equal(out.find((l) => l.providerSessionId === 'done-1')?.status, 'completed');
  // An opened resumed worker (in childSessions only) is running, not completed.
  assert.equal(out.find((l) => l.providerSessionId === 'open-1')?.status, 'running');
  assert.equal(out.find((l) => l.providerSessionId === 'gone-1')?.status, undefined);
});

test('childBelongsToSession accepts persisted child links for chat/spec sessions', () => {
  const manager = new SessionManager(() => {});
  const liveSession = {
    summary: testSummary('app-linked', 'droid-linked'),
    knownChildSessions: new Set<string>(),
    linkedChildSessions: new Set(['hist-worker-1']),
  };
  const internals = manager as unknown as {
    childBelongsToSession: (session: typeof liveSession, id: string) => boolean;
  };
  // A historical child known only from a persisted link is still openable.
  assert.equal(internals.childBelongsToSession(liveSession, 'hist-worker-1'), true);
  assert.equal(internals.childBelongsToSession(liveSession, 'unknown-worker'), false);
});

test('withLiveWorkerStatus leaves links untouched for historical sessions', () => {
  const manager = new SessionManager(() => {});
  const internals = manager as unknown as {
    withLiveWorkerStatus: (
      id: string,
      links: ChildSessionHistoryLink[],
    ) => ChildSessionHistoryLink[];
  };
  const links: ChildSessionHistoryLink[] = [{ providerSessionId: 'w1', toolUseId: 't1' }];
  assert.deepEqual(internals.withLiveWorkerStatus('not-live', links), links);
});

test('sendNow interrupts the live turn and prioritizes the steering prompt', async () => {
  const events: ServerEvent[] = [];
  const manager = new SessionManager((event) => events.push(event));
  const session = new FakeSession('droid-1');
  const liveSession = {
    summary: testSummary('app-1', session.sessionId),
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    childSessions: new Map(),
    knownChildSessions: new Set(),
    completedChildSessions: new Set(),
    terminalSources: new Set(),
    linkedChildSessions: new Set(),
    childSessionToolUseIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
    mcpServers: [],
    compacting: false,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      recordChildSessionLink: () => void;
      childSessionLinks: () => [];
    };
    sessions: Map<string, typeof liveSession>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    recordChildSessionLink: () => {},
    childSessionLinks: () => [],
  };
  internals.sessions.set(liveSession.summary.appSessionId, liveSession);

  const firstTurn = manager.handle({
    type: 'session.send',
    appSessionId: liveSession.summary.appSessionId,
    text: 'first',
  });
  await waitFor(() => session.prompts.includes('first'));

  await manager.handle({
    type: 'session.send',
    appSessionId: liveSession.summary.appSessionId,
    text: 'queued',
  });
  await manager.handle({
    type: 'session.sendNow',
    appSessionId: liveSession.summary.appSessionId,
    text: 'now',
  });

  await waitFor(() => session.prompts.length >= 3);
  await firstTurn;

  assert.equal(session.interrupts, 1);
  assert.deepEqual(session.prompts, ['first', 'now', 'queued']);
  assert.equal(liveSession.pendingSends.length, 0);
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
});

test('a stream AbortError without a user Stop surfaces as a failure, not a silent pause', async () => {
  const events: ServerEvent[] = [];
  const manager = new SessionManager((event) => events.push(event));
  class AbortingSession extends FakeSession {
    async *stream(prompt: string): AsyncGenerator<never, void, undefined> {
      this.prompts.push(prompt);
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
  }
  const session = new AbortingSession('droid-abort');
  const liveSession = {
    summary: testSummary('app-abort', session.sessionId),
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    childSessions: new Map(),
    knownChildSessions: new Set(),
    completedChildSessions: new Set(),
    terminalSources: new Set(),
    linkedChildSessions: new Set(),
    childSessionToolUseIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
    mcpServers: [],
    compacting: false,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      recordChildSessionLink: () => void;
      childSessionLinks: () => [];
    };
    sessions: Map<string, typeof liveSession>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    recordChildSessionLink: () => {},
    childSessionLinks: () => [],
  };
  internals.sessions.set(liveSession.summary.appSessionId, liveSession);

  // No user Stop was issued, so the abort is a real failure and must be
  // surfaced rather than masked as a quiet cancellation pause.
  await manager.handle({
    type: 'session.send',
    appSessionId: liveSession.summary.appSessionId,
    text: 'go',
  });
  await waitFor(() => events.some((event) => event.type === 'error'));
  assert.equal(liveSession.summary.phase, 'failed');
});

test('an idle Stop (no active turn) does not leave the interrupt flag set to poison a later turn', async () => {
  const events: ServerEvent[] = [];
  const manager = new SessionManager((event) => events.push(event));
  const session = new FakeSession('droid-idle-stop');
  const liveSession = {
    summary: testSummary('app-idle-stop', session.sessionId),
    session,
    streaming: false,
    interrupting: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    childSessions: new Map(),
    knownChildSessions: new Set(),
    completedChildSessions: new Set(),
    terminalSources: new Set(),
    linkedChildSessions: new Set(),
    childSessionToolUseIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
    mcpServers: [],
    compacting: false,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      recordChildSessionLink: () => void;
      childSessionLinks: () => [];
    };
    sessions: Map<string, typeof liveSession>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    recordChildSessionLink: () => {},
    childSessionLinks: () => [],
  };
  internals.sessions.set(liveSession.summary.appSessionId, liveSession);

  // Stop is pressed while no drive() is active. The flag must be cleared right
  // here (no finally will run), otherwise a later turn's cancellation would be
  // silently misclassified as a user Stop.
  await manager.handle({
    type: 'session.interrupt',
    appSessionId: liveSession.summary.appSessionId,
  });
  assert.equal(liveSession.streaming, false);
  assert.equal(liveSession.interrupting, false);
});

test('sendNow queues during compaction instead of driving or interrupting', async () => {
  const events: ServerEvent[] = [];
  const manager = new SessionManager((event) => events.push(event));
  const session = new FakeSession('droid-compact-now');
  const liveSession = {
    summary: testSummary('app-compact-now', session.sessionId),
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    childSessions: new Map(),
    knownChildSessions: new Set(),
    completedChildSessions: new Set(),
    terminalSources: new Set(),
    linkedChildSessions: new Set(),
    childSessionToolUseIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
    mcpServers: [],
    compacting: true,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      recordChildSessionLink: () => void;
      childSessionLinks: () => [];
    };
    sessions: Map<string, typeof liveSession>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    recordChildSessionLink: () => {},
    childSessionLinks: () => [],
  };
  internals.sessions.set(liveSession.summary.appSessionId, liveSession);

  // Manual compaction (compacting=true, streaming=false): must not drive() concurrently.
  await manager.handle({
    type: 'session.sendNow',
    appSessionId: liveSession.summary.appSessionId,
    text: 'steer-manual',
  });
  assert.deepEqual(session.prompts, []);
  assert.equal(session.interrupts, 0);

  // Compaction overlapping a turn (compacting=true, streaming=true): must not
  // interrupt the compaction.
  liveSession.streaming = true;
  await manager.handle({
    type: 'session.sendNow',
    appSessionId: liveSession.summary.appSessionId,
    text: 'steer-auto',
  });
  assert.equal(session.interrupts, 0);

  // Both steers are preserved at the front of the queue for delivery after compaction.
  assert.deepEqual(liveSession.pendingSends, ['steer-auto', 'steer-manual']);
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
});

test('design turns disable TodoWrite and normal turns restore it', async () => {
  const events: ServerEvent[] = [];
  const manager = new SessionManager((event) => events.push(event));
  const session = new FakeSession('droid-design');
  const liveSession = {
    summary: testSummary('app-design', session.sessionId),
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    childSessions: new Map(),
    knownChildSessions: new Set(),
    completedChildSessions: new Set(),
    terminalSources: new Set(),
    linkedChildSessions: new Set(),
    childSessionToolUseIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
    mcpServers: [],
    compacting: false,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      recordChildSessionLink: () => void;
      childSessionLinks: () => [];
    };
    sessions: Map<string, typeof liveSession>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    recordChildSessionLink: () => {},
    childSessionLinks: () => [],
  };
  internals.sessions.set(liveSession.summary.appSessionId, liveSession);

  const designPrompt =
    'Design Mode reference pack:\n- URL: about:blank\n\nUser instruction:\nMake the hero cleaner';

  // First normal turn (flag uninitialized) must still call updateSettings to
  // ensure TodoWrite is enabled — the session might have it disabled from a
  // prior design turn before the in-memory flag was lost to a page reload.
  await manager.handle({
    type: 'session.send',
    appSessionId: liveSession.summary.appSessionId,
    text: 'just a normal question',
  });
  await waitFor(() => session.prompts.includes('just a normal question'));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: [] });

  // Design turn disables TodoWrite.
  await manager.handle({
    type: 'session.send',
    appSessionId: liveSession.summary.appSessionId,
    text: designPrompt,
  });
  await waitFor(() => session.prompts.includes(designPrompt));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: ['TodoWrite'] });

  // Normal turn restores it.
  await manager.handle({
    type: 'session.send',
    appSessionId: liveSession.summary.appSessionId,
    text: 'another normal one',
  });
  await waitFor(() => session.prompts.includes('another normal one'));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: [] });

  // A second design turn re-disables it after the normal turn restored it.
  await manager.handle({
    type: 'session.send',
    appSessionId: liveSession.summary.appSessionId,
    text: `${designPrompt} again`,
  });
  await waitFor(() => session.prompts.includes(`${designPrompt} again`));
  assert.deepEqual(session.settingsUpdates.at(-1), { disabledToolIds: ['TodoWrite'] });
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
});

test('a cleared UI limit never disables the threshold check', () => {
  // Clearing means "back to the daemon default trigger", never "stop
  // auto-compacting".
  assert.equal(
    effectiveCompactionTriggerLimit({
      modelId: 'model-a',
      ui: { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
    }),
    250_000,
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

test('maps primary model changes and mirrors the spec-mode model', () => {
  // Spec-mode turns run on specModeModelId, so a model change must update both
  // or spec sessions keep generating with the previously selected model.
  assert.deepEqual(
    createSessionSettingsForAgent('primary', {
      modelId: 'model-b',
    }),
    {
      modelId: 'model-b',
      specModeModelId: 'model-b',
    },
  );
  assert.deepEqual(
    createSessionSettingsForAgent('primary', {
      modelId: 'model-b',
      reasoningEffort: 'high',
    }),
    {
      modelId: 'model-b',
      specModeModelId: 'model-b',
      reasoningEffort: 'high',
      specModeReasoningEffort: 'high',
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
  interrupts = 0;
  closes = 0;
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

  async interrupt(): Promise<void> {
    this.interrupts += 1;
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

  async close(): Promise<void> {
    this.closes += 1;
  }
}

function compactionHarness(used: number) {
  const events: ServerEvent[] = [];
  const manager = new SessionManager((event) => events.push(event));
  const session = new FakeCompactionSession('droid-compact', used);
  const liveSession = {
    summary: testSummary('app-compact', session.sessionId),
    session,
    streaming: false,
    pendingSends: [],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    childSessions: new Map(),
    knownChildSessions: new Set(),
    completedChildSessions: new Set(),
    terminalSources: new Set(),
    linkedChildSessions: new Set(),
    childSessionToolUseIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
    mcpServers: [],
    compacting: false,
    autoCompacting: false,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      summaryPatches: () => Map<string, unknown>;
      hiddenProviderSessionIds: () => Set<string>;
      recordChildSessionLink: () => void;
      childSessionLinks: () => [];
    };
    sessions: Map<string, typeof liveSession>;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenProviderSessionIds: () => new Set(),
    recordChildSessionLink: () => {},
    childSessionLinks: () => [],
  };
  internals.sessions.set(liveSession.summary.appSessionId, liveSession);
  return { manager, session, events, liveSession };
}

test('session creation immediately pushes daemon auto-compaction settings', async () => {
  const events: ServerEvent[] = [];
  const manager = new SessionManager((event) => events.push(event));
  const session = new FakeCompactionSession('droid-created', 0);
  const internals = manager as unknown as {
    ready: boolean;
    runtime: { createSession: () => Promise<FakeCompactionSession> };
    history: {
      syncSummaries: () => void;
      recordEvent: () => void;
    };
    getFactoryDefaults: () => Promise<Record<string, never>>;
    startLocalMcpServers: () => Promise<{ servers: []; configs: [] }>;
    drive: () => Promise<void>;
  };
  internals.ready = true;
  internals.runtime = { createSession: async () => session };
  internals.history = { syncSummaries: () => {}, recordEvent: () => {} };
  internals.getFactoryDefaults = async () => ({});
  internals.startLocalMcpServers = async () => ({ servers: [], configs: [] });
  internals.drive = async () => {};

  await manager.handle({
    type: 'session.create',
    sessionPurpose: 'chat',
    clientRef: 'create-ref',
    title: 'Created',
    goal: 'Test creation',
    interactionMode: 'auto',
    compactionTokenLimit: 120_000,
  });

  assert.deepEqual(session.settingsUpdates, [
    { compactionThresholdCheckEnabled: true, compactionTokenLimit: 120_000 },
  ]);
  assert.equal(
    events.some((event) => event.type === 'session.created'),
    true,
  );
});

test('manual compaction compacts an idle session and stays live', async () => {
  const { manager, session, events } = compactionHarness(250_000);
  await manager.handle({ type: 'session.compact', appSessionId: 'app-compact' });
  assert.equal(session.compactions, 1);
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
});

test('compaction failure surfaces a recoverable error and terminal status without failing the session', async () => {
  const { manager, session, events } = compactionHarness(250_000);
  session.failCompaction = true;
  await manager.handle({ type: 'session.compact', appSessionId: 'app-compact' });
  // Recoverable: a toast error is emitted without changing the session phase.
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
        e.type === 'event.appended' &&
        /could not finish/i.test((e as { event?: { text?: string } }).event?.text ?? ''),
    ),
    true,
  );
});

test('compaction status transcript IDs are unique within the same millisecond', async () => {
  const { manager, events } = compactionHarness(250_000);
  await manager.handle({ type: 'session.compact', appSessionId: 'app-compact' });
  const statusIds = events
    .filter(
      (e) =>
        e.type === 'event.appended' &&
        (e as { event?: { kind?: string } }).event?.kind === 'status',
    )
    .map((e) => (e as { event: { id: string } }).event.id);
  // The start ("Compacting conversation...") and terminal status can land in the
  // same ms; their IDs must differ so the UI doesn't drop the terminal one.
  assert.ok(statusIds.length >= 2);
  assert.equal(new Set(statusIds).size, statusIds.length);
});

test('Stop during compaction drops queued sends but does not interrupt the compaction', async () => {
  const { manager, session, liveSession } = compactionHarness(0);
  liveSession.compacting = true;
  let interrupts = 0;
  (session as unknown as { interrupt: () => Promise<void> }).interrupt = async () => {
    interrupts += 1;
  };
  // A send during compaction queues instead of driving.
  await manager.handle({ type: 'session.send', appSessionId: 'app-compact', text: 'queued' });
  assert.equal(liveSession.pendingSends.length, 1);
  // Stop must clear the queue but never interrupt the in-flight compaction.
  await manager.handle({ type: 'session.interrupt', appSessionId: 'app-compact' });
  assert.equal(interrupts, 0);
  assert.equal(liveSession.pendingSends.length, 0);
});

test('a normal turn never triggers client-side compaction', async () => {
  const { manager, session } = compactionHarness(250_000);
  await manager.handle({ type: 'session.send', appSessionId: 'app-compact', text: 'hello' });
  assert.equal(session.compactions, 0);
});

test('rejects manual compaction while streaming', async () => {
  const { manager, liveSession, events } = compactionHarness(250_000);
  liveSession.streaming = true;
  await manager.handle({
    type: 'session.compact',
    appSessionId: 'app-compact',
    customInstructions: undefined,
  });
  assert.equal(liveSession.streaming, true);
  const hasRejection = events.some(
    (e) =>
      e.type === 'event.appended' &&
      /cannot compact/i.test((e as { event?: { text?: string } }).event?.text ?? ''),
  );
  assert.equal(hasRejection, true);
});

test('daemonCompactionSettings enables the daemon threshold check with the UI limit', () => {
  assert.deepEqual(daemonCompactionSettings(200_000), {
    compactionThresholdCheckEnabled: true,
    compactionTokenLimit: 200_000,
  });
  // Without a limit, the check is still enabled against the daemon's default.
  assert.deepEqual(daemonCompactionSettings(undefined), {
    compactionThresholdCheckEnabled: true,
  });
});

type CompactionNotificationInternals = {
  handleCompactionNotification: (
    appSessionId: string,
    providerSessionId: string,
    role: 'primary' | 'worker',
    session: unknown,
    note: Record<string, unknown>,
  ) => boolean;
  closeChildSessionWhenIdle: (appSessionId: string, providerSessionId: string) => Promise<void>;
};

test('daemon compaction notifications surface start and completion statuses', async () => {
  const { manager, session, events } = compactionHarness(10_000);
  const internals = manager as unknown as CompactionNotificationInternals;

  const started = internals.handleCompactionNotification(
    'app-compact',
    'app-compact',
    'primary',
    session,
    {
      params: {
        notification: {
          type: 'droid_working_state_changed',
          newState: 'compacting_conversation',
        },
      },
    },
  );
  const completed = internals.handleCompactionNotification(
    'app-compact',
    'app-compact',
    'primary',
    session,
    {
      params: { notification: { type: 'session_compacted', summaryId: 's1', removedCount: 12 } },
    },
  );
  assert.equal(started, true);
  assert.equal(completed, true);

  const statuses = events
    .filter(
      (e) =>
        e.type === 'event.appended' &&
        (e as { event?: { kind?: string } }).event?.kind === 'status',
    )
    .map((e) => (e as { event: { text: string; compactType?: string } }).event);
  assert.ok(statuses.some((s) => /Compacting conversation/i.test(s.text)));
  // The completion line stays terse: no removed-count noise in the transcript.
  assert.ok(statuses.some((s) => s.text === 'Compaction complete.'));
  // Both surface as auto so the UI folds them into the auto-compaction divider.
  assert.ok(statuses.every((s) => s.compactType === 'auto'));
  // The daemon compacts in place: no swap, no session id change, no compact RPC.
  assert.equal(session.compactions, 0);
});

test('daemon compaction notifications protect primary compaction from steering and Stop', async () => {
  const { manager, session, liveSession } = compactionHarness(10_000);
  const internals = manager as unknown as CompactionNotificationInternals;

  internals.handleCompactionNotification('app-compact', 'app-compact', 'primary', session, {
    params: {
      notification: {
        type: 'droid_working_state_changed',
        newState: 'compacting_conversation',
      },
    },
  });
  assert.equal(liveSession.autoCompacting, true);

  await manager.handle({
    type: 'session.sendNow',
    appSessionId: 'app-compact',
    text: 'after compaction',
  });
  assert.equal(session.interrupts, 0);
  assert.deepEqual(liveSession.pendingSends, ['after compaction']);

  // Stop is the user's escape hatch: it settles the auto-compacting flag and
  // interrupts for real, so a lost session_compacted can never wedge the chat.
  await manager.handle({ type: 'session.interrupt', appSessionId: 'app-compact' });
  assert.equal(session.interrupts, 1);
  assert.equal(liveSession.autoCompacting, false);
  assert.deepEqual(liveSession.pendingSends, []);

  // The late completion is now a duplicate: it must not re-enter compaction
  // accounting (status, counter, context reset).
  internals.handleCompactionNotification('app-compact', 'app-compact', 'primary', session, {
    params: { notification: { type: 'session_compacted', summaryId: 's1', removedCount: 12 } },
  });
  assert.equal(liveSession.autoCompacting, false);
  assert.equal(liveSession.summary.autoCompactions ?? 0, 0);
});

test('daemon compaction notifications protect worker compaction from steering and Stop', async () => {
  const { manager, liveSession } = compactionHarness(10_000);
  const session = new FakeCompactionSession('worker-1', 10_000);
  const agent = {
    session,
    appSessionId: 'app-compact',
    role: 'worker' as const,
    streaming: true,
    autoCompacting: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
  };
  liveSession.linkedChildSessions.add('worker-1');
  liveSession.childSessions.set('worker-1', agent);
  const internals = manager as unknown as CompactionNotificationInternals;

  internals.handleCompactionNotification('app-compact', 'worker-1', 'worker', session, {
    params: {
      notification: {
        type: 'droid_working_state_changed',
        newState: 'compacting_conversation',
      },
    },
  });
  assert.equal(agent.autoCompacting, true);

  await manager.handle({
    type: 'child.sendNow',
    appSessionId: 'app-compact',
    providerSessionId: 'worker-1',
    text: 'after compaction',
  });
  assert.equal(session.interrupts, 0);
  assert.deepEqual(agent.pendingSends, ['after compaction']);

  // Same escape hatch as the primary session: Stop settles the flag and
  // interrupts instead of being silently swallowed.
  await manager.handle({
    type: 'child.interrupt',
    appSessionId: 'app-compact',
    providerSessionId: 'worker-1',
  });
  assert.equal(session.interrupts, 1);
  assert.equal(agent.autoCompacting, false);
  assert.deepEqual(agent.pendingSends, []);

  // A completion with no in-flight start is a late duplicate and stays inert.
  internals.handleCompactionNotification('app-compact', 'worker-1', 'worker', session, {
    params: { notification: { type: 'session_compacted', summaryId: 's1', removedCount: 5 } },
  });
  assert.equal(agent.autoCompacting, false);
});

test('worker post-turn watchdog re-arms on the child-map key, not the live provider id', async () => {
  const { manager, liveSession } = compactionHarness(10_000);
  // The live provider id intentionally differs from the child-map key.
  const session = new FakeCompactionSession('daemon-worker-raw', 10_000);
  const agent = {
    session,
    providerSessionId: 'worker-1',
    appSessionId: 'app-compact',
    role: 'worker' as const,
    streaming: false,
    autoCompacting: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
  };
  liveSession.linkedChildSessions.add('worker-1');
  liveSession.childSessions.set('worker-1', agent);
  const internals = manager as unknown as CompactionNotificationInternals & {
    driveChildSession: (agent: unknown, text: string) => Promise<void>;
    autoCompactionWatchdogs: { isArmed: (key: string) => boolean };
  };

  internals.handleCompactionNotification('app-compact', 'worker-1', 'worker', session, {
    params: {
      notification: { type: 'droid_working_state_changed', newState: 'compacting_conversation' },
    },
  });
  assert.equal(agent.autoCompacting, true);
  assert.equal(internals.autoCompactionWatchdogs.isArmed('worker-1'), true);

  await internals.driveChildSession(agent, 'go');

  // The tightened post-turn timer must replace the start-of-compaction timer,
  // so it has to live under the same key every other watchdog op uses.
  assert.equal(internals.autoCompactionWatchdogs.isArmed('worker-1'), true);
  assert.equal(internals.autoCompactionWatchdogs.isArmed('daemon-worker-raw'), false);
});

test('auto-compaction settlement drains queued primary and worker sends', async () => {
  const { manager, session, liveSession } = compactionHarness(10_000);
  const internals = manager as unknown as CompactionNotificationInternals;

  internals.handleCompactionNotification('app-compact', 'app-compact', 'primary', session, {
    params: {
      notification: {
        type: 'droid_working_state_changed',
        newState: 'compacting_conversation',
      },
    },
  });
  await manager.handle({
    type: 'session.send',
    appSessionId: 'app-compact',
    text: 'primary next',
  });
  internals.handleCompactionNotification('app-compact', 'app-compact', 'primary', session, {
    params: {
      notification: { type: 'droid_working_state_changed', newState: 'idle' },
    },
  });

  const workerSession = new FakeCompactionSession('worker-drain', 10_000);
  const worker = {
    session: workerSession,
    appSessionId: 'app-compact',
    role: 'worker' as const,
    streaming: false,
    autoCompacting: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
  };
  liveSession.linkedChildSessions.add('worker-drain');
  liveSession.childSessions.set('worker-drain', worker);
  internals.handleCompactionNotification('app-compact', 'worker-drain', 'worker', workerSession, {
    params: {
      notification: {
        type: 'droid_working_state_changed',
        newState: 'compacting_conversation',
      },
    },
  });
  await manager.handle({
    type: 'child.send',
    appSessionId: 'app-compact',
    providerSessionId: 'worker-drain',
    text: 'worker next',
  });
  internals.handleCompactionNotification('app-compact', 'worker-drain', 'worker', workerSession, {
    params: { notification: { type: 'session_compacted', removedCount: 5 } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(session.prompts, ['primary next']);
  assert.deepEqual(liveSession.pendingSends, []);
  assert.deepEqual(workerSession.prompts, ['worker next']);
  assert.deepEqual(worker.pendingSends, []);
});

test('worker completion waits for auto-compaction before closing its transport', async () => {
  const { manager, liveSession } = compactionHarness(10_000);
  const session = new FakeCompactionSession('worker-close', 10_000);
  const agent = {
    session,
    providerSessionId: 'worker-close',
    appSessionId: 'app-compact',
    role: 'worker' as const,
    streaming: false,
    autoCompacting: true,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
  };
  liveSession.childSessions.set('worker-close', agent);
  const internals = manager as unknown as CompactionNotificationInternals;

  await internals.closeChildSessionWhenIdle('app-compact', 'worker-close');
  assert.equal(session.closes, 0);
  assert.equal(liveSession.childSessions.has('worker-close'), true);

  internals.handleCompactionNotification('app-compact', 'worker-close', 'worker', session, {
    params: { notification: { type: 'session_compacted', removedCount: 5 } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.closes, 1);
  assert.equal(liveSession.childSessions.has('worker-close'), false);
});

test('deferred worker close resolves the child by its map key, not its live provider id', async () => {
  const { manager, liveSession } = compactionHarness(10_000);
  const session = new FakeCompactionSession('worker-close-live', 10_000);
  liveSession.childSessions.set('worker-close-key', {
    session,
    providerSessionId: 'worker-close-key',
    appSessionId: 'app-compact',
    role: 'worker' as const,
    streaming: false,
    autoCompacting: true,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
  });
  const internals = manager as unknown as CompactionNotificationInternals;

  await internals.closeChildSessionWhenIdle('app-compact', 'worker-close-key');
  assert.equal(session.closes, 0);

  internals.handleCompactionNotification('app-compact', 'worker-close-key', 'worker', session, {
    params: { notification: { type: 'session_compacted', removedCount: 5 } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.closes, 1);
  assert.equal(liveSession.childSessions.has('worker-close-key'), false);
});

test('worker in-place compaction bumps its snapshot generation, not the parent summary', async () => {
  const { manager, events, liveSession } = compactionHarness(10_000);
  const session = new FakeCompactionSession('worker-1', 10_000);
  liveSession.linkedChildSessions.add('worker-1');
  liveSession.childSessions.set('worker-1', {
    session,
    appSessionId: 'app-compact',
    role: 'worker' as const,
    streaming: false,
    autoCompacting: false,
    pendingSends: [] as string[],
    lastUsedAt: Date.now(),
  });
  const internals = manager as unknown as CompactionNotificationInternals;

  internals.handleCompactionNotification('app-compact', 'worker-1', 'worker', session, {
    params: {
      notification: { type: 'droid_working_state_changed', newState: 'compacting_conversation' },
    },
  });
  const handled = internals.handleCompactionNotification(
    'app-compact',
    'worker-1',
    'worker',
    session,
    {
      params: { notification: { type: 'session_compacted', summaryId: 's1', removedCount: 5 } },
    },
  );
  assert.equal(handled, true);
  // The post-compaction context refresh is fire-and-forget.
  await new Promise((resolve) => setImmediate(resolve));

  const ctx = events.find(
    (e) =>
      e.type === 'context.updated' &&
      (e as { sourceSessionId?: string }).sourceSessionId === 'worker-1',
  ) as { stats: { compactions?: number } } | undefined;
  assert.equal(ctx?.stats.compactions, 1);
  assert.equal(liveSession.summary.autoCompactions ?? 0, 0);
});

test('worker token readings never mark the parent summary exact; primary readings do', () => {
  const { manager, liveSession } = compactionHarness(10_000);
  const internals = manager as unknown as {
    applyNormalizedForSource: (
      appSessionId: string,
      providerSessionId: string,
      n: { tokens: { tokensIn: number; tokensOut: number; contextTokens: number } },
    ) => void;
  };

  internals.applyNormalizedForSource('app-compact', 'app-compact', {
    tokens: { tokensIn: 5, tokensOut: 2, contextTokens: 9 },
  });
  assert.equal(liveSession.summary.contextAccuracy, 'exact');
  assert.equal(liveSession.summary.contextTokens, 9);

  // A later worker turn must not clobber the primary session's context reading
  // (value or accuracy); only the running totals move.
  internals.applyNormalizedForSource('app-compact', 'worker-1', {
    tokens: { tokensIn: 50, tokensOut: 20, contextTokens: 70 },
  });
  assert.equal(liveSession.summary.contextTokens, 9);
  assert.equal(liveSession.summary.contextAccuracy, 'exact');
  assert.equal(liveSession.summary.tokensIn, 50);
});

test('non-compaction notifications are ignored by the compaction handler', () => {
  const { manager, session, events } = compactionHarness(10_000);
  const internals = manager as unknown as CompactionNotificationInternals;
  const handled = internals.handleCompactionNotification(
    'app-compact',
    'app-compact',
    'primary',
    session,
    {
      params: {
        notification: { type: 'droid_working_state_changed', newState: 'thinking' },
      },
    },
  );
  assert.equal(handled, false);
  assert.equal(
    events.some((e) => e.type === 'event.appended'),
    false,
  );
});

function primarySwapHarness(used: number, swapTo: string) {
  const events: ServerEvent[] = [];
  const manager = new SessionManager((event) => events.push(event));
  const session = new FakeCompactionSession('droid-old', used, swapTo);
  const liveSession = {
    summary: testSummary('app-swap', session.sessionId),
    session,
    streaming: false,
    pendingSends: [] as string[],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    childSessions: new Map(),
    knownChildSessions: new Set<string>(),
    completedChildSessions: new Set<string>(),
    terminalSources: new Set<string>(),
    linkedChildSessions: new Set<string>(),
    childSessionToolUseIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
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
      hiddenProviderSessionIds: () => Set<string>;
      recordChildSessionLink: () => void;
      childSessionLinks: () => [];
    };
    sessions: Map<string, typeof liveSession>;
    runtime: { loadSession: (id: string, handlers: unknown) => Promise<FakeCompactionSession> };
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    summaryPatches: () => new Map(),
    hiddenProviderSessionIds: () => new Set(),
    recordChildSessionLink: () => {},
    childSessionLinks: () => [],
  };
  internals.sessions.set(liveSession.summary.appSessionId, liveSession);
  return { manager, session, events, liveSession, internals };
}

test('primary compaction swap re-enables daemon auto-compaction on the new provider session', async () => {
  const { manager, liveSession, internals } = primarySwapHarness(250_000, 'droid-new');
  const swapped = new FakeCompactionSession('droid-new', 10_000);
  internals.runtime = { loadSession: async () => swapped };
  (
    manager as unknown as { getFactoryDefaults: () => Promise<{ compactionTokenLimit: number }> }
  ).getFactoryDefaults = async () => ({ compactionTokenLimit: 150_000 });

  await manager.handle({ type: 'session.compact', appSessionId: 'app-swap' });

  assert.equal(liveSession.session.sessionId, 'droid-new');
  // Settings live on the daemon session, not the persisted file, so the swap
  // must re-push the threshold check with the ContextMeter limit.
  assert.deepEqual(swapped.settingsUpdates, [
    { compactionThresholdCheckEnabled: true, compactionTokenLimit: 150_000 },
  ]);
});

test('primary compaction swap recovers when the first reload fails but a retry succeeds', async () => {
  const { manager, session, events, liveSession, internals } = primarySwapHarness(
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
  liveSession.pendingSends.push('queued');
  await manager.handle({ type: 'session.compact', appSessionId: 'app-swap' });
  // Adopted on retry: the live session is the new backing id, persisted on the summary.
  assert.equal(liveSession.session.sessionId, 'droid-new');
  assert.equal(liveSession.summary.providerSessionId, 'droid-new');
  assert.equal(loadCalls, 2);
  // The application session stays live and its queued send drains to the new provider.
  assert.equal(internals.sessions.has('app-swap'), true);
  await waitFor(() => swapped.prompts.includes('queued'));
  assert.equal(swapped.prompts.includes('queued'), true);
  // The old (swapped-away) session never receives the queued send.
  assert.equal(session.prompts.includes('queued'), false);
  // Recovered transiently: no reload error is emitted.
  assert.equal(
    events.some((e) => e.type === 'error' && /reloading it failed/i.test(e.message)),
    false,
  );
});

test('failed primary compaction adoption drops the live session and re-delivers through resume', async () => {
  const { manager, session, events, liveSession, internals } = primarySwapHarness(
    250_000,
    'droid-new',
  );
  internals.runtime = {
    loadSession: async () => {
      throw new Error('permanent load failure');
    },
  };
  let closedId: string | undefined;
  // Stub disk-backed teardown; assert the live session is dropped for re-resume.
  (manager as unknown as { closeSession: (id: string) => Promise<void> }).closeSession = async (
    id: string,
  ) => {
    closedId = id;
    internals.sessions.delete(id);
  };
  // Simulate a successful lazy resume: re-register the live session on the new id.
  const resumed = new FakeCompactionSession('droid-new', 10_000);
  let resumeCalls = 0;
  (manager as unknown as { resumeSession: (id: string) => Promise<void> }).resumeSession = async (
    id: string,
  ) => {
    resumeCalls += 1;
    internals.sessions.set(id, {
      ...liveSession,
      session: resumed,
      streaming: false,
      compacting: false,
      pendingSends: [],
    });
  };
  liveSession.pendingSends.push('queued-after-recovery');
  await manager.handle({ type: 'session.compact', appSessionId: 'app-swap' });
  // The daemon's new backing id is persisted so a later send re-resumes the live session...
  assert.equal(liveSession.summary.providerSessionId, 'droid-new');
  // ...the live session is dropped (the next send re-resumes it)...
  assert.equal(closedId, 'app-swap');
  // ...a recoverable error is surfaced without changing the session phase...
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
});

test('manual compaction swap that never reloads re-delivers sends queued during compaction', async () => {
  const { manager, session, events, liveSession, internals } = primarySwapHarness(
    10_000,
    'droid-new',
  );
  internals.runtime = {
    loadSession: async () => {
      throw new Error('permanent load failure');
    },
  };
  let closedId: string | undefined;
  (manager as unknown as { closeSession: (id: string) => Promise<void> }).closeSession = async (
    id: string,
  ) => {
    closedId = id;
    internals.sessions.delete(id);
  };
  const resumed = new FakeCompactionSession('droid-new', 10_000);
  let resumeCalls = 0;
  (manager as unknown as { resumeSession: (id: string) => Promise<void> }).resumeSession = async (
    id: string,
  ) => {
    resumeCalls += 1;
    internals.sessions.set(id, {
      ...liveSession,
      session: resumed,
      streaming: false,
      compacting: false,
      pendingSends: [],
    });
  };
  // A prompt queued while the manual compaction was running.
  liveSession.pendingSends.push('queued-during-manual');
  await manager.handle({ type: 'session.compact', appSessionId: 'app-swap' });
  // The live session is dropped and the new provider id is persisted...
  assert.equal(closedId, 'app-swap');
  assert.equal(liveSession.summary.providerSessionId, 'droid-new');
  // ...the queued prompt is re-delivered through resume (not discarded)...
  await waitFor(() => resumed.prompts.includes('queued-during-manual'));
  assert.equal(resumeCalls >= 1, true);
  // ...without ever streaming into the dead old session; recovery is surfaced.
  assert.equal(session.prompts.includes('queued-during-manual'), false);
  assert.equal(
    events.some((e) => e.type === 'error' && /reloading it failed/i.test(e.message)),
    true,
  );
});

// ── #30/#17: opening a worker always settles its loading state ──

test('#30/#17 opening a worker on a non-live session settles loading with an honest open', async () => {
  const events: ServerEvent[] = [];
  const manager = new SessionManager((event) => events.push(event));
  // No session is registered, so openChildSession cannot resume one. It must still ack
  // 'opened' (honest empty) so the worker card stops loading forever instead of
  // hanging on the optimistic loading flag the client set before subscribing.
  await manager.handle({
    type: 'child.open',
    appSessionId: 'ghost-session',
    providerSessionId: 'w1',
  });
  assert.ok(
    events.some(
      (e) =>
        e.type === 'child.updated' &&
        (e as { providerSessionId?: string }).providerSessionId === 'w1' &&
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
  const manager = new SessionManager((event) => events.push(event));
  const session = new FakeScriptedSession('droid-term', turns);
  const liveSession = {
    summary: testSummary('app-term', session.sessionId),
    session,
    streaming: false,
    pendingSends: [] as string[],
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    childSessions: new Map(),
    knownChildSessions: new Set(),
    completedChildSessions: new Set(),
    terminalSources: new Set<string>(),
    linkedChildSessions: new Set(),
    childSessionToolUseIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
    mcpServers: [],
    compacting: false,
  };
  const internals = manager as unknown as {
    history: {
      recordEvent: () => void;
      syncSummaries: () => void;
      recordChildSessionLink: () => void;
      childSessionLinks: () => [];
    };
    sessions: Map<string, typeof liveSession>;
    applyEvent: (
      appSessionId: string,
      providerSessionId: string,
      role: string,
      ev: Record<string, unknown>,
    ) => void;
    applyNormalizedForSource: (
      appSessionId: string,
      providerSessionId: string,
      n: { transcript?: Record<string, unknown>; done?: boolean; childSession?: unknown },
    ) => void;
  };
  internals.history = {
    recordEvent: () => {},
    syncSummaries: () => {},
    recordChildSessionLink: () => {},
    childSessionLinks: () => [],
  };
  internals.sessions.set(liveSession.summary.appSessionId, liveSession);
  const transcriptTexts = () =>
    events
      .filter((e) => e.type === 'event.appended')
      .map((e) => (e as { event: { text?: string } }).event.text);
  return { manager, events, liveSession, internals, session, transcriptTexts };
}

test('#19 a turn keeps its pre-terminal answer but drops generation after the result', async () => {
  const { manager, liveSession, transcriptTexts } = terminalHarness([
    [
      { type: 'assistant_text_delta', text: 'final answer' },
      { type: 'result' },
      { type: 'assistant_text_delta', text: 'leaked tail' },
      { type: 'tool_call', toolUse: { id: 'late', name: 'Grep', input: { pattern: 'x' } } },
    ],
    [{ type: 'assistant_text_delta', text: 'second turn answer' }],
  ]);

  await manager.handle({ type: 'session.send', appSessionId: 'app-term', text: 'first' });
  await waitFor(
    () => liveSession.streaming === false && transcriptTexts().includes('final answer'),
  );

  // The pre-terminal answer is kept; post-terminal generation is quarantined.
  assert.ok(transcriptTexts().includes('final answer'));
  assert.ok(!transcriptTexts().includes('leaked tail'));
  // The session is flagged terminal for this turn.
  assert.ok(liveSession.terminalSources.has('app-term'));

  // The next turn resets the flag so its answer flows again.
  await manager.handle({ type: 'session.send', appSessionId: 'app-term', text: 'second' });
  await waitFor(() => transcriptTexts().includes('second turn answer'));
  assert.ok(!liveSession.terminalSources.has('app-term'));
});

test('#19 terminal enforcement is scoped per agent session', () => {
  const { liveSession, internals, transcriptTexts } = terminalHarness([]);
  // The primary turn is terminal, but a worker on the same app session is not.
  liveSession.terminalSources.add('app-term');
  internals.applyEvent('app-term', 'worker-1', 'worker', {
    type: 'assistant_text_delta',
    text: 'worker still talking',
  });
  internals.applyEvent('app-term', 'app-term', 'primary', {
    type: 'assistant_text_delta',
    text: 'primary blocked',
  });
  assert.ok(transcriptTexts().includes('worker still talking'));
  assert.ok(!transcriptTexts().includes('primary blocked'));
});

test('#19 a failed result after the terminal result still surfaces', () => {
  const { internals, transcriptTexts } = terminalHarness([]);
  internals.applyEvent('app-term', 'app-term', 'primary', { type: 'result' });
  // A failed tool result is not model "generation"; it must surface post-terminal.
  internals.applyEvent('app-term', 'app-term', 'primary', {
    type: 'tool_result',
    toolName: 'Execute',
    content: 'boom',
    isError: true,
  });
  assert.ok(transcriptTexts().includes('boom'));
});

test('#19 a post-terminal child spawn keeps its worker signal and drops only tool transcript', () => {
  const { events, internals } = terminalHarness([]);
  internals.applyEvent('app-term', 'app-term', 'primary', { type: 'result' });
  internals.applyEvent('app-term', 'app-term', 'primary', {
    type: 'tool_call',
    subagentSessionId: 'w1',
    toolUse: { id: 'tA', name: 'Task', input: { subagent_type: 'worker', prompt: 'go' } },
  });
  // The child-session side effect still flows (worker started)...
  assert.ok(
    events.some(
      (e) =>
        e.type === 'session.child' &&
        (e as { event?: string }).event === 'started' &&
        (e as { providerSessionId?: string }).providerSessionId === 'w1',
    ),
  );
  // ...but the primary session's own Task tool_call transcript is quarantined.
  assert.ok(
    !events.some(
      (e) =>
        e.type === 'event.appended' &&
        (e as { event?: { kind?: string; toolName?: string } }).event?.kind === 'tool_call' &&
        (e as { event?: { toolName?: string } }).event?.toolName === 'Task',
    ),
  );
});

test('#19 post-terminal generation is dropped on the shared agent entry (notification path)', () => {
  const { liveSession, internals, transcriptTexts } = terminalHarness([]);
  // Worker notifications now route through applyNormalizedForSource, so a late
  // text delta for a terminal worker is quarantined here too, not just on the
  // stream loop.
  liveSession.terminalSources.add('w1');
  internals.applyNormalizedForSource('app-term', 'w1', {
    transcript: {
      id: 'late-1',
      appSessionId: 'app-term',
      providerSessionId: 'w1',
      role: 'worker',
      ts: 1,
      kind: 'text',
      text: 'late worker tail',
    },
  });
  assert.ok(!transcriptTexts().includes('late worker tail'));
});
