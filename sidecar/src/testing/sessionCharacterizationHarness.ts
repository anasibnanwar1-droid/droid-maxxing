import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SdkMcpServer } from '@factory/droid-sdk';

import { MissionManager } from '../MissionManager.js';
import type {
  CreateRuntimeSessionOptions,
  RuntimeHandlers,
  RuntimeStatus,
} from '../DroidRuntime.js';
import type {
  ClientCommand,
  FactoryDefaultSettings,
  ModelInfo,
  MissionSummary,
  ServerEvent,
} from '../protocol.js';

/* eslint-disable @typescript-eslint/dot-notation -- ProcessEnv requires indexed access under strict TypeScript. */

export interface RecordedCall {
  target: 'runtime' | 'provider' | 'history' | 'browser' | 'cleanup' | 'protocol';
  method: string;
  args: unknown[];
}

export class FakeDroidSession {
  readonly prompts: string[] = [];
  readonly settings: Record<string, unknown>[] = [];
  nextUpdateSettingsError?: Error;
  readonly notifications = new Set<(note: Record<string, unknown>) => void>();
  readonly initResult: {
    sessionId: string;
    modelId: string;
    reasoningEffort: string;
  };

  constructor(
    readonly sessionId: string,
    readonly handlers: RuntimeHandlers,
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
    await Promise.resolve();
    yield { type: 'result' };
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
}

export class FakeRuntime {
  readonly createCalls: CreateRuntimeSessionOptions[] = [];
  readonly createQueue: (FakeDroidSession | Error)[] = [];
  readonly sessions = new Map<string, FakeDroidSession>();
  private apiKey = '';

  constructor(private readonly calls: RecordedCall[]) {}

  connect(apiKey?: string): void {
    if (apiKey) this.apiKey = apiKey;
    this.calls.push({ target: 'runtime', method: 'connect', args: [apiKey] });
  }

  status(): RuntimeStatus {
    return {
      mode: 'cli_auth',
      droidPath: '/test/droid',
      apiKeyConfigured: this.apiKey.length > 0,
    };
  }

  createSession(options: CreateRuntimeSessionOptions): Promise<FakeDroidSession> {
    this.createCalls.push(options);
    this.calls.push({ target: 'runtime', method: 'createSession', args: [options] });
    const next =
      this.createQueue.shift() ??
      new FakeDroidSession(`provider-${String(this.createCalls.length)}`, options, this.calls);
    if (next instanceof Error) return Promise.reject(next);
    this.sessions.set(next.sessionId, next);
    return Promise.resolve(next);
  }
}

export class FakeHistoryIndex {
  readonly summaries: MissionSummary[] = [];

  constructor(private readonly calls: RecordedCall[]) {}

  syncSummaries(summaries: MissionSummary[]): void {
    this.summaries.push(...summaries);
    this.calls.push({ target: 'history', method: 'syncSummaries', args: [summaries] });
  }

  summaryPatches(): Map<string, Partial<MissionSummary>> {
    return new Map(this.summaries.map((summary) => [summary.id, summary]));
  }

  hiddenDroidSessionIds(): Set<string> {
    return new Set();
  }

  recordEvent(event: unknown): void {
    this.calls.push({ target: 'history', method: 'recordEvent', args: [event] });
  }

  close(): void {
    this.calls.push({ target: 'cleanup', method: 'history.close', args: [] });
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

interface McpCloseObserver {
  readonly calls: () => number;
  restore(): void;
}

let mcpCloseObserverActive = false;

function observeMcpServerClose(): McpCloseObserver {
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
  readonly events: ServerEvent[];
  readonly calls: RecordedCall[];
  readonly runtime: FakeRuntime;
  readonly provider: {
    session(id: string): FakeDroidSession;
    emitNotification(id: string, note: Record<string, unknown>): void;
  };
  readonly history: FakeHistoryIndex;
  readonly browsers: FakeBrowserSessionManager;
  readonly home: string;
  readonly mcpServerCloseCalls: number;
  handle(command: ClientCommand): Promise<void>;
  create(command: Omit<Extract<ClientCommand, { type: 'mission.create' }>, 'type'>): Promise<void>;
  dispose(): Promise<void>;
}

export function createSessionCharacterizationHarness(
  options: { defaults?: FactoryDefaultSettings } = {},
): SessionCharacterizationHarness {
  const calls: RecordedCall[] = [];
  const events: ServerEvent[] = [];
  const recordEvent = (event: ServerEvent) => {
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
  const history = new FakeHistoryIndex(calls);
  const browsers = new FakeBrowserSessionManager(calls);
  const privateManager = readyManager as unknown as {
    runtime: unknown;
    history: { close(): void };
    browsers: unknown;
    cachedModels: ModelInfo[] | null;
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

  const handle = async (command: ClientCommand): Promise<void> => {
    await withHome(home, () => readyManager.handle(command));
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    events,
    calls,
    runtime,
    provider: {
      session: (id) => {
        const session = runtime.sessions.get(id);
        if (!session) throw new Error(`Unknown fake provider session ${id}`);
        return session;
      },
      emitNotification: (id, note) => {
        const session = runtime.sessions.get(id);
        if (!session) throw new Error(`Unknown fake provider session ${id}`);
        session.emitNotification(note);
      },
    },
    history,
    browsers,
    home,
    get mcpServerCloseCalls() {
      return mcpCloseObserver.calls();
    },
    handle,
    create: (command) => handle({ type: 'mission.create', ...command }),
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

function writeDefaults(home: string, defaults?: FactoryDefaultSettings): void {
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
