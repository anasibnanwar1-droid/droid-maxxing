import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SdkMcpServer } from '@factory/droid-sdk';

import { MissionManager } from '../MissionManager.js';
import type * as Runtime from '../DroidRuntime.js';
import type * as Protocol from '../protocol.js';

/* eslint-disable @typescript-eslint/dot-notation -- ProcessEnv requires indexed access under strict TypeScript. */

export interface RecordedCall {
  target: 'runtime' | 'provider' | 'history' | 'browser' | 'cleanup' | 'protocol';
  method: string;
  args: unknown[];
}

export interface StreamGate {
  resolve(): void;
}

type DeferredStream = StreamGate & { readonly promise: Promise<void> };

export class FakeDroidSession {
  readonly prompts: string[] = [];
  readonly settings: Record<string, unknown>[] = [];
  nextEnterSpecModeError?: Error;
  nextUpdateSettingsError?: Error;
  readonly notifications = new Set<(note: Record<string, unknown>) => void>();
  private readonly streamGates: DeferredStream[] = [];
  private readonly promptWaiters: { count: number; resolve(): void }[] = [];
  readonly initResult: {
    sessionId: string;
    modelId: string;
    reasoningEffort: string;
  };

  constructor(
    readonly sessionId: string,
    readonly handlers: Runtime.RuntimeHandlers,
    private readonly calls: RecordedCall[],
  ) {
    this.initResult = {
      sessionId,
      modelId: 'model-default',
      reasoningEffort: 'medium',
    };
  }

  async *stream(
    prompt: string,
    _options: { includePartialMessages: true },
  ): AsyncGenerator<unknown, void, undefined> {
    void _options;
    this.prompts.push(prompt);
    this.calls.push({ target: 'provider', method: 'stream', args: [this.sessionId, prompt] });
    this.resolvePromptWaiters();
    await this.streamGates.shift()?.promise;
    yield { type: 'result' };
  }

  deferNextStream(): StreamGate {
    let release: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate: DeferredStream = { promise, resolve: () => release?.() };
    this.streamGates.push(gate);
    return gate;
  }

  waitForPrompts(count: number): Promise<void> {
    if (this.prompts.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.promptWaiters.push({ count, resolve }));
  }

  interrupt(): Promise<void> {
    this.calls.push({ target: 'provider', method: 'interrupt', args: [this.sessionId] });
    return Promise.resolve();
  }

  enterSpecMode(): Promise<void> {
    this.calls.push({ target: 'provider', method: 'enterSpecMode', args: [this.sessionId] });
    const error = this.nextEnterSpecModeError;
    delete this.nextEnterSpecModeError;
    return error ? Promise.reject(error) : Promise.resolve();
  }

  updateSettings(settings: Record<string, unknown>): Promise<Record<string, never>> {
    this.settings.push(settings);
    this.calls.push({
      target: 'provider',
      method: 'updateSettings',
      args: [this.sessionId, settings],
    });
    const error = this.nextUpdateSettingsError;
    delete this.nextUpdateSettingsError;
    return error ? Promise.reject(error) : Promise.resolve({});
  }

  onNotification(listener: (note: Record<string, unknown>) => void): () => void {
    this.notifications.add(listener);
    this.calls.push({ target: 'provider', method: 'onNotification', args: [this.sessionId] });
    return () => {
      this.notifications.delete(listener);
      this.calls.push({ target: 'cleanup', method: 'unsubscribe', args: [this.sessionId] });
    };
  }

  emitNotification(note: Record<string, unknown>): void {
    for (const listener of this.notifications) listener(note);
  }

  getContextStats(): Promise<{
    used: number;
    remaining: number;
    limit: number;
    accuracy: 'estimated';
    updatedAt: string;
  }> {
    return Promise.resolve({
      used: 0,
      remaining: 1_000,
      limit: 1_000,
      accuracy: 'estimated',
      updatedAt: new Date(0).toISOString(),
    });
  }

  close(): Promise<void> {
    this.calls.push({ target: 'cleanup', method: 'session.close', args: [this.sessionId] });
    return Promise.resolve();
  }

  private resolvePromptWaiters(): void {
    for (let index = this.promptWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.promptWaiters.at(index);
      if (!waiter) continue;
      if (this.prompts.length >= waiter.count) {
        this.promptWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

export class FakeRuntime {
  readonly createCalls: Runtime.CreateRuntimeSessionOptions[] = [];
  readonly createQueue: (FakeDroidSession | Error)[] = [];
  readonly loadCalls: { sessionId: string; handlers: Runtime.RuntimeHandlers }[] = [];
  readonly loadQueue = new Map<string, (FakeDroidSession | Error)[]>();
  readonly sessions = new Map<string, FakeDroidSession>();
  private apiKey = '';

  constructor(private readonly calls: RecordedCall[]) {}

  connect(apiKey?: string): void {
    if (apiKey) this.apiKey = apiKey;
    this.calls.push({ target: 'runtime', method: 'connect', args: [apiKey] });
  }

  status(): Runtime.RuntimeStatus {
    return {
      mode: 'cli_auth',
      droidPath: '/test/droid',
      apiKeyConfigured: this.apiKey.length > 0,
    };
  }

  createSession(options: Runtime.CreateRuntimeSessionOptions): Promise<FakeDroidSession> {
    this.createCalls.push(options);
    this.calls.push({ target: 'runtime', method: 'createSession', args: [options] });
    const next =
      this.createQueue.shift() ??
      new FakeDroidSession(`provider-${String(this.createCalls.length)}`, options, this.calls);
    if (next instanceof Error) return Promise.reject(next);
    this.sessions.set(next.sessionId, next);
    return Promise.resolve(next);
  }

  deferNextCreateStream(sessionId: string): StreamGate {
    const session = new FakeDroidSession(sessionId, {}, this.calls);
    const gate = session.deferNextStream();
    this.createQueue.push(session);
    return gate;
  }

  loadSession(sessionId: string, handlers: Runtime.RuntimeHandlers): Promise<FakeDroidSession> {
    this.loadCalls.push({ sessionId, handlers });
    this.calls.push({ target: 'runtime', method: 'loadSession', args: [sessionId, handlers] });
    const next =
      this.loadQueue.get(sessionId)?.shift() ??
      new FakeDroidSession(sessionId, handlers, this.calls);
    if (next instanceof Error) return Promise.reject(next);
    this.sessions.set(next.sessionId, next);
    return Promise.resolve(next);
  }
}

export class FakeHistoryIndex {
  readonly summaries: Protocol.MissionSummary[] = [];
  private readonly links = new Map<string, Protocol.WorkerHistoryLink[]>();

  constructor(
    private readonly calls: RecordedCall[],
    private readonly home: string,
  ) {}

  syncSummaries(summaries: Protocol.MissionSummary[]): void {
    this.summaries.push(...summaries);
    for (const summary of summaries) this.writeSessionStart(summary);
    this.calls.push({ target: 'history', method: 'syncSummaries', args: [summaries] });
  }

  seedSubagentLinks(missionId: string, links: Protocol.WorkerHistoryLink[]): void {
    this.links.set(missionId, links);
  }

  summaryPatches(): Map<string, Partial<Protocol.MissionSummary>> {
    return new Map(
      this.summaries.flatMap((summary) => [
        [summary.id, summary],
        [summary.sessionId ?? summary.id, summary],
      ]),
    );
  }

  hiddenDroidSessionIds(): Set<string> {
    return new Set();
  }

  recordSubagentLink(
    missionId: string,
    toolUseId: string,
    workerSessionId: string,
    label?: string,
  ): void {
    const links = this.links.get(missionId) ?? [];
    const index = links.findIndex((existing) => existing.toolUseId === toolUseId);
    links[index < 0 ? links.length : index] =
      label === undefined ? { workerSessionId, toolUseId } : { workerSessionId, toolUseId, label };
    this.links.set(missionId, links);
    this.calls.push({
      target: 'history',
      method: 'recordSubagentLink',
      args: [missionId, toolUseId, workerSessionId, label],
    });
  }

  subagentLinks(missionId: string): Protocol.WorkerHistoryLink[] {
    return (this.links.get(missionId) ?? []).map((link) => ({ ...link }));
  }

  recordEvent(event: unknown): void {
    this.calls.push({ target: 'history', method: 'recordEvent', args: [event] });
  }

  close(): void {
    this.calls.push({ target: 'cleanup', method: 'history.close', args: [] });
  }

  private writeSessionStart(summary: Protocol.MissionSummary): void {
    const sessionId = summary.sessionId ?? summary.id;
    const sessions = path.join(this.home, '.factory', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      path.join(sessions, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'session_start',
        sessionId,
        sessionTitle: summary.title,
        cwd: summary.cwd,
      })}\n`,
    );
  }
}

export class FakeBrowserSessionManager {
  constructor(private readonly calls: RecordedCall[]) {}

  close(missionId: string): Promise<void> {
    this.calls.push({ target: 'cleanup', method: 'browser.close', args: [missionId] });
    return Promise.resolve();
  }

  closeAll(): Promise<void> {
    this.calls.push({ target: 'cleanup', method: 'browser.closeAll', args: [] });
    return Promise.resolve();
  }
}

let mcpCloseObserverActive = false;

function observeMcpServerClose() {
  if (mcpCloseObserverActive)
    throw new Error('Session characterization harnesses must not overlap.');

  // eslint-disable-next-line @typescript-eslint/unbound-method -- the wrapper restores the receiver.
  const originalClose = SdkMcpServer.prototype.close;
  let closeCalls = 0;
  const wrappedClose = function (
    this: SdkMcpServer,
    ...args: Parameters<typeof originalClose>
  ): Promise<void> {
    closeCalls += 1;
    return originalClose.apply(this, args);
  };

  SdkMcpServer.prototype.close = wrappedClose;
  mcpCloseObserverActive = true;

  return {
    calls: () => closeCalls,
    restore: () => {
      if (SdkMcpServer.prototype.close === wrappedClose)
        SdkMcpServer.prototype.close = originalClose;
      mcpCloseObserverActive = false;
    },
  };
}

export interface SessionCharacterizationHarness {
  readonly events: Protocol.ServerEvent[];
  readonly calls: RecordedCall[];
  readonly runtime: FakeRuntime;
  readonly provider: {
    session(id: string): FakeDroidSession;
    deferNextStream(id: string): StreamGate;
    waitForPrompts(id: string, count: number): Promise<void>;
    emitNotification(id: string, note: Record<string, unknown>): void;
  };
  readonly history: FakeHistoryIndex;
  readonly fixture: {
    seedHistorySummaries(summaries: Protocol.MissionSummary[]): void;
    seedSubagentLinks(missionId: string, links: Protocol.WorkerHistoryLink[]): void;
  };
  readonly browsers: FakeBrowserSessionManager;
  readonly home: string;
  readonly mcpServerCloseCalls: number;
  handle(command: Protocol.ClientCommand): Promise<void>;
  create(
    command: Omit<Extract<Protocol.ClientCommand, { type: 'mission.create' }>, 'type'>,
  ): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

export function createSessionCharacterizationHarness(
  options: { defaults?: Protocol.FactoryDefaultSettings } = {},
): SessionCharacterizationHarness {
  const calls: RecordedCall[] = [];
  const events: Protocol.ServerEvent[] = [];
  const recordEvent = (event: Protocol.ServerEvent) => {
    events.push(event);
    calls.push({ target: 'protocol', method: 'event', args: [event] });
  };
  const home = mkdtempSync(path.join(tmpdir(), 'mission-manager-characterization-'));
  writeDefaults(home, options.defaults);

  let manager: MissionManager | undefined;
  try {
    withHomeSync(home, () => {
      manager = new MissionManager(recordEvent);
    });
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  if (!manager) {
    rmSync(home, { recursive: true, force: true });
    throw new Error('MissionManager construction did not complete.');
  }

  const readyManager = manager;
  const runtime = new FakeRuntime(calls);
  const history = new FakeHistoryIndex(calls, home);
  const browsers = new FakeBrowserSessionManager(calls);
  const privateManager = readyManager as unknown as {
    runtime: unknown;
    history: { close(): void };
    browsers: unknown;
    cachedModels: Protocol.ModelInfo[] | null;
  };
  privateManager.history.close();
  privateManager.runtime = runtime;
  privateManager.history = history;
  privateManager.browsers = browsers;
  privateManager.cachedModels = [
    {
      id: 'model-default',
      displayName: 'Default',
      isCustom: false,
      maxContextTokens: 1_000,
    },
  ];

  const mcpCloseObserver = (() => {
    try {
      return observeMcpServerClose();
    } catch (error) {
      rmSync(home, { recursive: true, force: true });
      throw error;
    }
  })();
  let disposed = false;

  const handle = async (command: Protocol.ClientCommand): Promise<void> => {
    await withHome(home, () => readyManager.handle(command));
    await Promise.resolve();
    await Promise.resolve();
  };
  const providerSession = (id: string): FakeDroidSession => {
    const session = runtime.sessions.get(id);
    if (!session) throw new Error(`Unknown fake provider session ${id}`);
    return session;
  };

  return {
    events,
    calls,
    runtime,
    provider: {
      session: providerSession,
      deferNextStream: (id) => providerSession(id).deferNextStream(),
      waitForPrompts: (id, count) => providerSession(id).waitForPrompts(count),
      emitNotification: (id, note) => {
        providerSession(id).emitNotification(note);
      },
    },
    history,
    fixture: {
      seedHistorySummaries: (summaries) => {
        history.syncSummaries(summaries);
      },
      seedSubagentLinks: (missionId, links) => {
        history.seedSubagentLinks(missionId, links);
      },
    },
    browsers,
    home,
    get mcpServerCloseCalls() {
      return mcpCloseObserver.calls();
    },
    handle,
    create: (command) => handle({ type: 'mission.create', ...command }),
    waitForIdle: () => new Promise((resolve) => setImmediate(resolve)),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await withHome(home, () => readyManager.shutdown());
      } finally {
        mcpCloseObserver.restore();
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

async function withHome<T>(home: string, action: () => Promise<T>): Promise<T> {
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  try {
    return await action();
  } finally {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
  }
}

function withHomeSync<T>(home: string, action: () => T): T {
  const previousHome = process.env['HOME'];
  process.env['HOME'] = home;
  try {
    return action();
  } finally {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
  }
}

function writeDefaults(home: string, defaults?: Protocol.FactoryDefaultSettings): void {
  if (!defaults) return;
  const factoryDir = path.join(home, '.factory');
  mkdirSync(factoryDir, { recursive: true });
  writeFileSync(
    path.join(factoryDir, 'settings.json'),
    JSON.stringify({
      compactionModel: defaults.compactionModel,
      compactionTokenLimit: defaults.compactionTokenLimit,
      compactionTokenLimitPerModel: defaults.compactionTokenLimitPerModel,
      missionOrchestratorModel: defaults.missionOrchestratorModelId,
      missionOrchestratorReasoningEffort: defaults.missionOrchestratorReasoningEffort,
      sessionDefaultSettings: {
        model: defaults.modelId,
        reasoningEffort: defaults.reasoningEffort,
        compactionModel: defaults.compactionModel,
        autonomyLevel: defaults.autonomy,
        interactionMode: defaults.interactionMode,
        specModeModel: defaults.specModelId,
        specModeReasoningEffort: defaults.specReasoningEffort,
      },
      missionModelSettings: {
        workerModel: defaults.workerModelId,
        workerReasoningEffort: defaults.workerReasoningEffort,
        validationWorkerModel: defaults.validatorModelId,
        validationWorkerReasoningEffort: defaults.validatorReasoningEffort,
      },
    }),
  );
}
