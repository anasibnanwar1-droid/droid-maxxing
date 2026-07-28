import {
  ContextStatsAccuracy,
  dispatchNotification,
  InitializeSessionResultSchema,
  MissionSnapshotSchema,
  ReasoningEffort as SdkReasoningEffort,
  type DroidResultMessage,
  type DroidStreamEvent,
  type MessageOptions,
  type MissionFeature,
  type NotificationCallback,
  type NotificationFilter,
  type NotificationListener,
  type UpdateSessionSettingsRequestParams,
} from '@factory/droid-sdk';

import type { ReasoningEffort } from '../protocol.js';
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

export interface RejectableGate extends StreamGate {
  reject(error: unknown): void;
}

interface DeferredStream extends StreamGate {
  readonly promise: Promise<void>;
}

interface DeferredRejectable extends RejectableGate {
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
  nextCompactError?: Error;
  nextStreamError?: Error;
  nextEnterSpecModeError?: Error;
  nextUpdateSettingsError?: Error;
  readonly notifications = new Set<NotificationListener>();
  initResult: FactorySession['initResult'];

  private readonly streamGates: DeferredStream[] = [];
  private readonly streamEventQueue: DroidStreamEvent[][] = [];
  private readonly promptWaiters: { count: number; resolve(): void }[] = [];
  private nextCompactGate?: DeferredStream;
  private nextContextStatsGate?: DeferredStream;
  private nextUpdateSettingsGate?: DeferredStream;
  private nextCloseGate?: DeferredStream;
  private nextInterruptGate?: DeferredRejectable;

  constructor(
    readonly sessionId: string,
    readonly handlers: RuntimeHandlers,
    private readonly calls: RecordedCall[],
    init: FakeFactorySessionInit = {},
  ) {
    this.initResult = buildInitResult(sessionId, init);
  }

  async *stream(
    prompt: string,
    options: MessageOptions & { includePartialMessages: true },
  ): AsyncGenerator<DroidStreamEvent, void, undefined> {
    this.prompts.push(prompt);
    this.calls.push({
      target: 'provider',
      method: 'stream',
      args: [this.sessionId, prompt, options],
    });
    this.resolvePromptWaiters();
    await this.streamGates.shift()?.promise;
    const streamError = this.nextStreamError;
    delete this.nextStreamError;
    if (streamError) throw streamError;
    const events = this.streamEventQueue.shift() ?? [];
    for (const event of events) yield event;
    if (!events.some((event) => event.type === 'result')) {
      yield successfulResultEvent(this.sessionId);
    }
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

  deferNextContextStats(): StreamGate {
    const gate = this.defer();
    this.nextContextStatsGate = gate;
    return gate;
  }

  deferNextUpdateSettings(): StreamGate {
    const gate = this.defer();
    this.nextUpdateSettingsGate = gate;
    return gate;
  }

  deferNextClose(): StreamGate {
    const gate = this.defer();
    this.nextCloseGate = gate;
    return gate;
  }

  deferNextInterrupt(): RejectableGate {
    const gate = this.deferRejectable();
    this.nextInterruptGate = gate;
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
    const error = this.nextCompactError;
    delete this.nextCompactError;
    if (error) throw error;
    return this.nextCompactResult ?? { newSessionId: this.sessionId, removedCount: 0 };
  }

  async interrupt(): Promise<void> {
    this.calls.push({ target: 'provider', method: 'interrupt', args: [this.sessionId] });
    const gate = this.nextInterruptGate;
    delete this.nextInterruptGate;
    await gate?.promise;
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

  async updateSettings(
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
    const gate = this.nextUpdateSettingsGate;
    delete this.nextUpdateSettingsGate;
    await gate?.promise;
    if (error) throw error;
    return {};
  }

  onNotification(listener: NotificationCallback, filter?: NotificationFilter): () => void {
    const subscription: NotificationListener = {
      callback: listener,
      ...(filter === undefined ? {} : { filter }),
    };
    this.notifications.add(subscription);
    this.calls.push({ target: 'provider', method: 'onNotification', args: [this.sessionId] });
    return () => {
      this.notifications.delete(subscription);
      this.calls.push({ target: 'cleanup', method: 'unsubscribe', args: [this.sessionId] });
    };
  }

  emitNotification(note: Record<string, unknown>): void {
    dispatchNotification(note, this.notifications);
  }

  async getContextStats(): ReturnType<FactorySession['getContextStats']> {
    const gate = this.nextContextStatsGate;
    delete this.nextContextStatsGate;
    await gate?.promise;
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
    const gate = this.nextCloseGate;
    delete this.nextCloseGate;
    return gate?.promise ?? Promise.resolve();
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

  private deferRejectable(): DeferredRejectable {
    let release = (): void => undefined;
    let fail = (error: unknown): void => {
      void error;
    };
    const promise = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    return { promise, resolve: release, reject: fail };
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
      new FakeFactorySession(`provider-${String(this.createCalls.length)}`, options, this.calls, {
        settings: {
          ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
          ...(options.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: options.reasoningEffort }),
          interactionMode: options.interactionMode,
        },
      });
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
      reasoningEffort: settings.reasoningEffort ?? SdkReasoningEffort.Medium,
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

export function successfulResultEvent(sessionId: string): DroidResultMessage {
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

export function assistantTextDelta(text: string, messageId = 'message-1'): DroidStreamEvent {
  return {
    type: 'assistant_text_delta',
    messageId,
    blockIndex: 0,
    text,
  };
}

function unsupportedSessionMethod(method: string): Promise<never> {
  return Promise.reject(new Error(`FakeFactorySession does not implement ${method}.`));
}
