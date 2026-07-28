import {
  ContextStatsAccuracy,
  InitializeSessionResultSchema,
  MissionSnapshotSchema,
  ReasoningEffort,
  type DroidResultMessage,
  type DroidStreamEvent,
  type DroidStreamMessage,
  type MessageOptions,
  type MissionFeature,
  type NotificationCallback,
  type NotificationFilter,
  type UpdateSessionSettingsRequestParams,
} from '@factory/droid-sdk';

import type {
  CreateRuntimeSessionOptions,
  FactoryRuntime,
  FactorySession,
  RuntimeHandlers,
  RuntimeStatus,
} from '../DroidRuntime.js';

export interface RecordedCall {
  target: 'runtime' | 'provider' | 'history' | 'browser' | 'cleanup' | 'protocol';
  method: string;
  args: unknown[];
}

export interface StreamGate {
  resolve(): void;
}

interface DeferredStream extends StreamGate {
  readonly promise: Promise<void>;
}

export interface FakeFactorySessionInit {
  settings?: {
    modelId?: string;
    reasoningEffort?: ReasoningEffort;
    interactionMode?: 'auto' | 'spec' | 'agi';
  };
  mission?: {
    state?: string;
    features?: MissionFeature[];
  };
}

export class FakeFactorySession implements FactorySession {
  readonly prompts: string[] = [];
  readonly settings: Record<string, unknown>[] = [];
  nextCompactResult?: Awaited<ReturnType<FactorySession['compactSession']>>;
  nextEnterSpecModeError?: Error;
  nextUpdateSettingsError?: Error;
  readonly notifications = new Set<NotificationCallback>();
  initResult: FactorySession['initResult'];

  private readonly streamGates: DeferredStream[] = [];
  private readonly streamEventQueue: DroidStreamEvent[][] = [];
  private readonly promptWaiters: { count: number; resolve(): void }[] = [];
  private nextCompactGate?: DeferredStream;

  constructor(
    readonly sessionId: string,
    readonly handlers: RuntimeHandlers,
    private readonly calls: RecordedCall[],
    init: FakeFactorySessionInit = {},
  ) {
    this.initResult = buildInitResult(sessionId, init);
  }

  stream(
    prompt: string,
    options?: MessageOptions & { includePartialMessages?: false },
  ): AsyncGenerator<DroidStreamMessage, void, undefined>;
  stream(
    prompt: string,
    options: MessageOptions & { includePartialMessages: true },
  ): AsyncGenerator<DroidStreamEvent, void, undefined>;
  async *stream(
    prompt: string,
    options: MessageOptions = {},
  ): AsyncGenerator<DroidStreamEvent, void, undefined> {
    void options;
    this.prompts.push(prompt);
    this.calls.push({ target: 'provider', method: 'stream', args: [this.sessionId, prompt] });
    this.resolvePromptWaiters();
    await this.streamGates.shift()?.promise;
    for (const event of this.streamEventQueue.shift() ?? []) yield event;
    yield successfulResult(this.sessionId);
  }

  queueStreamEvents(events: DroidStreamEvent[]): void {
    this.streamEventQueue.push(events);
  }

  setInitModel(modelId: string): void {
    this.initResult = InitializeSessionResultSchema.parse({
      ...this.initResult,
      sessionId: this.sessionId,
      settings: { ...this.initResult.settings, modelId },
    });
  }

  deferNextStream(): StreamGate {
    return this.defer(this.streamGates);
  }

  deferNextCompaction(): StreamGate {
    const gate = this.defer();
    this.nextCompactGate = gate;
    return gate;
  }

  waitForPrompts(count: number): Promise<void> {
    if (this.prompts.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.promptWaiters.push({ count, resolve }));
  }

  async compactSession(
    options: Parameters<FactorySession['compactSession']>[0] = {},
  ): Promise<Awaited<ReturnType<FactorySession['compactSession']>>> {
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

  enterSpecMode(
    ...args: Parameters<FactorySession['enterSpecMode']>
  ): Promise<Awaited<ReturnType<FactorySession['enterSpecMode']>>> {
    this.calls.push({
      target: 'provider',
      method: 'enterSpecMode',
      args: [this.sessionId, ...args],
    });
    const error = this.nextEnterSpecModeError;
    delete this.nextEnterSpecModeError;
    return error ? Promise.reject(error) : Promise.resolve({});
  }

  updateSettings(
    settings: Partial<UpdateSessionSettingsRequestParams>,
  ): Promise<Awaited<ReturnType<FactorySession['updateSettings']>>> {
    this.settings.push({ ...settings });
    this.calls.push({
      target: 'provider',
      method: 'updateSettings',
      args: [this.sessionId, settings],
    });
    const error = this.nextUpdateSettingsError;
    delete this.nextUpdateSettingsError;
    return error ? Promise.reject(error) : Promise.resolve({});
  }

  onNotification(listener: NotificationCallback, filter?: NotificationFilter): () => void {
    void filter;
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

  getContextStats(): ReturnType<FactorySession['getContextStats']> {
    return Promise.resolve({
      used: 0,
      remaining: 1_000,
      limit: 1_000,
      accuracy: ContextStatsAccuracy.Estimated,
      updatedAt: new Date(0).toISOString(),
    });
  }

  close(): Promise<void> {
    this.calls.push({ target: 'cleanup', method: 'session.close', args: [this.sessionId] });
    return Promise.resolve();
  }

  readonly forkSession: FactorySession['forkSession'] = () =>
    unsupportedSessionMethod('forkSession');

  readonly renameSession: FactorySession['renameSession'] = () =>
    unsupportedSessionMethod('renameSession');

  readonly getRewindInfo: FactorySession['getRewindInfo'] = () =>
    unsupportedSessionMethod('getRewindInfo');

  readonly executeRewind: FactorySession['executeRewind'] = () =>
    unsupportedSessionMethod('executeRewind');

  readonly listTools: FactorySession['listTools'] = () => unsupportedSessionMethod('listTools');

  readonly listSkills: FactorySession['listSkills'] = () => unsupportedSessionMethod('listSkills');

  readonly listMcpServers: FactorySession['listMcpServers'] = () =>
    unsupportedSessionMethod('listMcpServers');

  readonly listMcpTools: FactorySession['listMcpTools'] = () =>
    unsupportedSessionMethod('listMcpTools');

  private defer(gates?: DeferredStream[]): DeferredStream {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = { promise, resolve: release };
    gates?.push(gate);
    return gate;
  }

  private resolvePromptWaiters(): void {
    for (let index = this.promptWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.promptWaiters.at(index);
      if (!waiter || this.prompts.length < waiter.count) continue;
      this.promptWaiters.splice(index, 1);
      waiter.resolve();
    }
  }
}

export class FakeFactoryRuntime implements FactoryRuntime {
  readonly createCalls: CreateRuntimeSessionOptions[] = [];
  readonly createQueue: (FakeFactorySession | Error)[] = [];
  readonly loadCalls: { sessionId: string; handlers: RuntimeHandlers }[] = [];
  readonly loadQueue = new Map<string, (FakeFactorySession | Error)[]>();
  readonly sessions = new Map<string, FakeFactorySession>();
  private apiKey = '';

  constructor(private readonly calls: RecordedCall[]) {}

  connect(apiKey?: string): void {
    if (apiKey) this.apiKey = apiKey;
    this.calls.push({ target: 'runtime', method: 'connect', args: [apiKey] });
  }

  status(): RuntimeStatus {
    return { mode: 'cli_auth', droidPath: '/test/droid', apiKeyConfigured: this.apiKey.length > 0 };
  }

  startCliLogin(): Promise<void> {
    this.calls.push({ target: 'runtime', method: 'startCliLogin', args: [] });
    return Promise.resolve();
  }

  createSession(options: CreateRuntimeSessionOptions): Promise<FakeFactorySession> {
    this.createCalls.push(options);
    this.calls.push({ target: 'runtime', method: 'createSession', args: [options] });
    const next =
      this.createQueue.shift() ??
      new FakeFactorySession(`provider-${String(this.createCalls.length)}`, options, this.calls);
    if (next instanceof Error) return Promise.reject(next);
    this.sessions.set(next.sessionId, next);
    return Promise.resolve(next);
  }

  deferNextCreateStream(sessionId: string): StreamGate {
    const session = new FakeFactorySession(sessionId, {}, this.calls);
    this.createQueue.push(session);
    return session.deferNextStream();
  }

  loadSession(sessionId: string, handlers: RuntimeHandlers = {}): Promise<FakeFactorySession> {
    this.loadCalls.push({ sessionId, handlers });
    this.calls.push({ target: 'runtime', method: 'loadSession', args: [sessionId, handlers] });
    const next =
      this.loadQueue.get(sessionId)?.shift() ??
      new FakeFactorySession(sessionId, handlers, this.calls);
    if (next instanceof Error) return Promise.reject(next);
    this.sessions.set(next.sessionId, next);
    return Promise.resolve(next);
  }
}

function buildInitResult(
  sessionId: string,
  init: FakeFactorySessionInit,
): FactorySession['initResult'] {
  const settings = init.settings ?? {};
  return InitializeSessionResultSchema.parse({
    sessionId,
    session: {},
    settings: {
      modelId: settings.modelId ?? 'model-default',
      reasoningEffort: settings.reasoningEffort ?? ReasoningEffort.Medium,
      ...(settings.interactionMode === undefined
        ? {}
        : { interactionMode: settings.interactionMode }),
    },
    ...(init.mission === undefined
      ? {}
      : {
          mission: MissionSnapshotSchema.parse({
            state: init.mission.state ?? 'running',
            features: init.mission.features ?? [],
            progressLog: [],
            workerSessionIds: [],
          }),
        }),
  });
}

function successfulResult(sessionId: string): DroidResultMessage {
  return {
    type: 'result',
    sessionId,
    durationMs: 0,
    numTurns: 1,
    result: '',
    tokenUsage: null,
    messages: [],
    text: '',
    turnCount: 1,
    success: true,
    subtype: 'success',
    isError: false,
    error: null,
  };
}

function unsupportedSessionMethod(method: string): Promise<never> {
  return Promise.reject(new Error(`FakeFactorySession does not implement ${method}.`));
}
