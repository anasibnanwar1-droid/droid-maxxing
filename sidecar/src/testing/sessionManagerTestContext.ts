import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { McpServerConfigSchema, type McpServerConfig } from '@factory/droid-sdk';

import {
  SessionManager,
  type SessionManagerDependencies,
  type StartableLocalMcpResource,
} from '../SessionManager.js';
import type * as Protocol from '../protocol.js';
import { FakeBrowserSessionManager } from './browserCharacterizationSupport.js';
import {
  FakeFactoryRuntime,
  type FakeFactorySession,
  type RecordedCall,
  type StreamGate,
} from './fakeFactoryRuntime.js';
import { FakeHistoryIndex } from './historyCharacterizationSupport.js';

/* eslint-disable @typescript-eslint/dot-notation -- ProcessEnv requires indexed access under strict TypeScript. */

const INITIAL_MODELS: Protocol.ModelInfo[] = [
  {
    id: 'model-default',
    displayName: 'Default',
    isCustom: false,
    maxContextTokens: 1_000,
  },
];

const LOCAL_MCP_CONFIG = McpServerConfigSchema.parse({
  type: 'http',
  name: 'test-browser',
  url: 'http://127.0.0.1/test',
});

export interface SessionManagerTestContext {
  readonly events: Protocol.ServerEvent[];
  readonly calls: RecordedCall[];
  readonly runtime: FakeFactoryRuntime;
  readonly provider: {
    session(id: string): FakeFactorySession;
    deferNextStream(id: string): StreamGate;
    deferNextCompaction(id: string): StreamGate;
    waitForPrompts(id: string, count: number): Promise<void>;
    emitNotification(id: string, note: Record<string, unknown>): void;
  };
  readonly history: FakeHistoryIndex;
  readonly fixture: {
    seedHistorySummaries(summaries: Protocol.SessionSummary[]): void;
    seedChildSessionLinks(appSessionId: string, links: Protocol.ChildSessionHistoryLink[]): void;
  };
  readonly browsers: FakeBrowserSessionManager;
  readonly home: string;
  readonly mcpServerCloseCalls: number;
  handle(command: Protocol.ClientCommand): Promise<void>;
  create(
    command: Omit<Extract<Protocol.ClientCommand, { type: 'session.create' }>, 'type'>,
  ): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

export interface NativeBrowserTestContext {
  readonly events: Protocol.ServerEvent[];
  handle(command: Protocol.ClientCommand): Promise<void>;
  dispose(): Promise<void>;
}

export function createSessionManagerTestContext(
  options: { defaults?: Protocol.FactoryDefaultSettings } = {},
): SessionManagerTestContext {
  const calls: RecordedCall[] = [];
  const events: Protocol.ServerEvent[] = [];
  const recordEvent = (event: Protocol.ServerEvent): void => {
    events.push(event);
    calls.push({ target: 'protocol', method: 'event', args: [event] });
  };
  const home = createTestHome(options.defaults);
  const runtime = new FakeFactoryRuntime(calls);
  const history = new FakeHistoryIndex(calls);
  const browsers = new FakeBrowserSessionManager((call) => calls.push(call), recordEvent);
  const dependencies: SessionManagerDependencies = {
    runtime,
    history,
    browsers,
    createLocalMcpResource: () => new FakeLocalMcpResource(calls),
  };

  let manager: SessionManager;
  try {
    manager = withHomeSync(
      home,
      () => new SessionManager(recordEvent, { dependencies, initialModels: INITIAL_MODELS }),
    );
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  let disposed = false;
  const handle = async (command: Protocol.ClientCommand): Promise<void> => {
    await withHome(home, () => manager.handle(command));
    await Promise.resolve();
    await Promise.resolve();
  };
  const providerSession = (id: string): FakeFactorySession => {
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
      seedChildSessionLinks: (appSessionId, links) => {
        history.seedChildSessionLinks(appSessionId, links);
      },
    },
    browsers,
    home,
    get mcpServerCloseCalls() {
      return calls.filter((call) => call.target === 'cleanup' && call.method === 'mcp.close')
        .length;
    },
    handle,
    create: (command) => handle({ type: 'session.create', ...command }),
    waitForIdle: () => new Promise((resolve) => setImmediate(resolve)),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await withHome(home, () => manager.shutdown());
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

export function createNativeBrowserTestContext(): NativeBrowserTestContext {
  const events: Protocol.ServerEvent[] = [];
  const recordEvent = (event: Protocol.ServerEvent): void => {
    events.push(event);
  };
  const home = createTestHome();

  // Native request/result correlation is wired by SessionManager while it composes
  // BrowserSessionManager, so this one focused context intentionally uses that
  // production composition. It only exercises local browser messages under an
  // isolated HOME; no provider session or authenticated runtime is started.
  let manager: SessionManager;
  try {
    manager = withHomeSync(
      home,
      () => new SessionManager(recordEvent, { initialModels: INITIAL_MODELS }),
    );
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  let disposed = false;
  return {
    events,
    handle: async (command) => {
      await withHome(home, () => manager.handle(command));
      await Promise.resolve();
      await Promise.resolve();
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await withHome(home, () => manager.shutdown());
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

class FakeLocalMcpResource implements StartableLocalMcpResource {
  constructor(private readonly calls: RecordedCall[]) {}

  start(): Promise<McpServerConfig> {
    return Promise.resolve(LOCAL_MCP_CONFIG);
  }

  close(): Promise<void> {
    this.calls.push({ target: 'cleanup', method: 'mcp.close', args: [] });
    return Promise.resolve();
  }
}

function createTestHome(defaults?: Protocol.FactoryDefaultSettings): string {
  const home = mkdtempSync(path.join(tmpdir(), 'session-manager-test-'));
  writeDefaults(home, defaults);
  return home;
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
