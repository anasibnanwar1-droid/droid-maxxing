import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SdkMcpServer } from '@factory/droid-sdk';

import { SessionManager } from '../SessionManager.js';
import { FakeBrowserSessionManager } from './browserCharacterizationSupport.js';
import { FakeHistoryIndex } from './historyCharacterizationSupport.js';
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
  nextCompactResult?: { newSessionId: string; removedCount: number };
  nextEnterSpecModeError?: Error;
  nextUpdateSettingsError?: Error;
  readonly notifications = new Set<(note: Record<string, unknown>) => void>();
  private readonly streamGates: DeferredStream[] = [];
  private nextCompactGate?: DeferredStream;
  private readonly promptWaiters: { count: number; resolve(): void }[] = [];
  readonly initResult: { sessionId: string; modelId: string; reasoningEffort: string };
  constructor(
    readonly sessionId: string,
    readonly handlers: Runtime.RuntimeHandlers,
    private readonly calls: RecordedCall[],
  ) {
    this.initResult = { sessionId, modelId: 'model-default', reasoningEffort: 'medium' };
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
    return this.defer(this.streamGates);
  }

  deferNextCompaction(): StreamGate {
    return (this.nextCompactGate = this.defer());
  }

  private defer(gates?: DeferredStream[]): DeferredStream {
    let release: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = { promise, resolve: () => release?.() };
    gates?.push(gate);
    return gate;
  }

  waitForPrompts(count: number): Promise<void> {
    if (this.prompts.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.promptWaiters.push({ count, resolve }));
  }

  async compactSession(
    options: { customInstructions?: string } = {},
  ): Promise<{ newSessionId: string; removedCount: number }> {
    this.calls.push({
      target: 'provider',
      method: 'compactSession',
      args: [this.sessionId, options],
    });
    const gate = this.nextCompactGate;
    delete this.nextCompactGate;
    await gate?.promise;
    return this.nextCompactResult ?? { newSessionId: this.sessionId, removedCount: 0 };
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

  getContextStats() {
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
    return { mode: 'cli_auth', droidPath: '/test/droid', apiKeyConfigured: this.apiKey.length > 0 };
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
    this.createQueue.push(session);
    return session.deferNextStream();
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
    deferNextCompaction(id: string): StreamGate;
    waitForPrompts(id: string, count: number): Promise<void>;
    emitNotification(id: string, note: Record<string, unknown>): void;
  };
  readonly history: FakeHistoryIndex;
  readonly fixture: {
    seedHistorySummaries(summaries: Protocol.SessionSummary[]): void;
    seedSubagentLinks(appSessionId: string, links: Protocol.ChildSessionHistoryLink[]): void;
  };
  readonly browsers: FakeBrowserSessionManager;
  readonly home: string;
  readonly mcpServerCloseCalls: number;
  handle(command: Protocol.ClientCommand): Promise<void>;
  create(
    command: Omit<
      Extract<Protocol.ClientCommand, { type: 'session.create' }>,
      'type' | 'sessionPurpose'
    >,
  ): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

export function createSessionCharacterizationHarness(
  options: { browser?: 'fake' | 'native'; defaults?: Protocol.FactoryDefaultSettings } = {},
): SessionCharacterizationHarness {
  const calls: RecordedCall[] = [];
  const events: Protocol.ServerEvent[] = [];
  const recordEvent = (event: Protocol.ServerEvent) => {
    events.push(event);
    calls.push({ target: 'protocol', method: 'event', args: [event] });
  };
  const home = mkdtempSync(path.join(tmpdir(), 'mission-manager-characterization-'));
  writeDefaults(home, options.defaults);

  let manager: SessionManager | undefined;
  try {
    withHomeSync(home, () => {
      manager = new SessionManager(recordEvent);
    });
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  if (!manager) {
    rmSync(home, { recursive: true, force: true });
    throw new Error('SessionManager construction did not complete.');
  }

  const readyManager = manager;
  const runtime = new FakeRuntime(calls);
  const history = new FakeHistoryIndex(calls);
  const browsers = new FakeBrowserSessionManager((call) => calls.push(call), recordEvent);
  const privateManager = readyManager as unknown as {
    runtime: unknown;
    history: { close(): void };
    browsers: unknown;
    cachedModels: Protocol.ModelInfo[] | null;
  };
  privateManager.history.close();
  privateManager.runtime = runtime;
  privateManager.history = history;
  if (options.browser !== 'native') privateManager.browsers = browsers;
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
      deferNextCompaction: (id) => providerSession(id).deferNextCompaction(),
      waitForPrompts: (id, count) => providerSession(id).waitForPrompts(count),
      emitNotification: (id, note) => {
        providerSession(id).emitNotification(note);
      },
    },
    history,
    fixture: {
      seedHistorySummaries: (summaries) => {
        history.seedSummaries(summaries);
      },
      seedSubagentLinks: (appSessionId, links) => {
        history.seedSubagentLinks(appSessionId, links);
      },
    },
    browsers,
    home,
    get mcpServerCloseCalls() {
      return mcpCloseObserver.calls();
    },
    handle,
    create: (command) =>
      handle({
        type: 'session.create',
        sessionPurpose: command.interactionMode === 'agi' ? 'mission-control' : 'chat',
        ...command,
      }),
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
