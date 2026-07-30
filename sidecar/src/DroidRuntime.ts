import {
  AutonomyLevel,
  ContextBreakdownResultSchema,
  DroidClient,
  DroidInteractionMode,
  DroidSession,
  ReasoningEffort as SdkReasoningEffort,
  type AskUserHandler,
  type DecompSessionType,
  type DroidClientTransport,
  type DroidStreamEvent,
  type InitializeSessionRequestParams,
  type LoadSessionRequestParams,
  type McpServerConfig,
  type MessageOptions,
  type PermissionHandler,
  type SendOptions,
} from '@factory/droid-sdk';
import { spawn } from 'node:child_process';
import { createDroidTransport } from './DroidTransport.js';
import { buildDroidInvocation, resolveDroidPath } from './Environment.js';
import type { Autonomy, ReasoningEffort, SessionInteractionMode } from './protocol.js';

const EXEC_ARGS = ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc'];
const SESSION_INIT_TIMEOUT_MS = 20_000;
const ignoreError = (): void => undefined;

export interface RuntimeHandlers {
  permissionHandler?: PermissionHandler;
  askUserHandler?: AskUserHandler;
  mcpServers?: McpServerConfig[];
}

export interface CreateRuntimeSessionOptions extends RuntimeHandlers {
  cwd: string;
  interactionMode: SessionInteractionMode;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  compactionModel?: string;
  compactionTokenLimit?: number;
  compactionThresholdCheckEnabled?: boolean;
  specModeModelId?: string;
  specModeReasoningEffort?: ReasoningEffort;
  autonomyLevel?: Autonomy;
  decompSessionType?: DecompSessionType;
  missionId?: string;
  workerModelId?: string;
  workerReasoningEffort?: ReasoningEffort;
  validatorModelId?: string;
  validatorReasoningEffort?: ReasoningEffort;
}

export interface RuntimeStatus {
  mode: 'cli_auth';
  droidPath: string;
  apiKeyConfigured: boolean;
}

type FactorySessionMethods = Pick<
  DroidSession,
  | 'sessionId'
  | 'initResult'
  | 'interrupt'
  | 'updateSettings'
  | 'enterSpecMode'
  | 'compactSession'
  | 'close'
  | 'onNotification'
  | 'getContextStats'
  | 'forkSession'
  | 'renameSession'
  | 'getRewindInfo'
  | 'executeRewind'
  | 'listTools'
  | 'listSkills'
  | 'listMcpServers'
  | 'listMcpTools'
>;

export type FactorySession = FactorySessionMethods & {
  send(prompt: string, options?: SendOptions): Promise<void>;
  stream(
    prompt: string,
    options: MessageOptions & { includePartialMessages: true },
  ): AsyncGenerator<DroidStreamEvent, void, undefined>;
};

export interface FactoryRuntime {
  connect(apiKey?: string): void;
  status(): RuntimeStatus;
  startCliLogin(): Promise<void>;
  createSession(options: CreateRuntimeSessionOptions): Promise<FactorySession>;
  loadSession(providerSessionId: string, handlers?: RuntimeHandlers): Promise<FactorySession>;
  readContextBreakdown(session: FactorySession): Promise<unknown>;
}

export class DroidRuntime implements FactoryRuntime {
  private explicitApiKey = '';

  connect(apiKey?: string): void {
    if (apiKey) this.explicitApiKey = apiKey;
  }

  status(): RuntimeStatus {
    return {
      mode: 'cli_auth',
      droidPath: this.resolveDroidPath(),
      apiKeyConfigured: this.explicitApiKey.length > 0,
    };
  }

  async readContextBreakdown(session: FactorySession): Promise<unknown> {
    try {
      const exposed = session as unknown as { getContextBreakdown?: () => Promise<unknown> };
      if (typeof exposed.getContextBreakdown === 'function')
        return await exposed.getContextBreakdown();

      const client = (
        session as unknown as {
          _client?: {
            _sessionRpcWithoutParams?: (method: string, schema: unknown) => Promise<unknown>;
          };
        }
      )._client;
      if (!client?._sessionRpcWithoutParams) return undefined;
      return await client._sessionRpcWithoutParams(
        'droid.get_context_breakdown',
        ContextBreakdownResultSchema,
      );
    } catch {
      return undefined;
    }
  }

  async createSession(options: CreateRuntimeSessionOptions): Promise<FactorySession> {
    const { client, transport } = await this.createClient(options.cwd, options);
    const params = createInitializeSessionParams(options);

    try {
      const init = await withTimeout(
        client.initializeSession(params),
        SESSION_INIT_TIMEOUT_MS,
        'initialize_session',
      );
      return createFactorySession(new DroidSession(client, init.sessionId, init), client);
    } catch (err) {
      await transport.close().catch(ignoreError);
      throw err;
    }
  }

  async loadSession(sessionId: string, handlers: RuntimeHandlers = {}): Promise<FactorySession> {
    const { client, transport } = await this.createClient(undefined, handlers);
    const params: LoadSessionRequestParams = { sessionId };
    if (handlers.mcpServers?.length) params.mcpServers = handlers.mcpServers;
    try {
      const init = await withTimeout(
        client.loadSession(params),
        SESSION_INIT_TIMEOUT_MS,
        'load_session',
      );
      return createFactorySession(new DroidSession(client, sessionId, init), client);
    } catch (err) {
      await transport.close().catch(ignoreError);
      throw err;
    }
  }

  startCliLogin(): Promise<void> {
    // On Windows the npm-installed `droid` is a `.cmd` shim that direct spawn
    // can't launch, so run it through a shell there.
    const child = spawn(this.resolveDroidPath(), ['login'], {
      env: this.env(),
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    // A missing/non-executable CLI makes spawn emit 'error'; without a listener
    // that would crash the sidecar, so swallow it here.
    child.on('error', ignoreError);
    child.unref();
    return Promise.resolve();
  }

  private async createClient(
    cwd?: string,
    handlers: RuntimeHandlers = {},
  ): Promise<{ client: DroidClient; transport: DroidClientTransport }> {
    const { execPath, execArgs } = buildDroidInvocation(EXEC_ARGS);
    const transport = createDroidTransport({
      execPath,
      execArgs,
      cwd,
      env: this.env(),
    });
    await transport.connect();
    const client = new DroidClient({ transport });
    if (handlers.permissionHandler) client.setPermissionHandler(handlers.permissionHandler);
    if (handlers.askUserHandler) client.setAskUserHandler(handlers.askUserHandler);
    return { client, transport };
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }

    if (this.explicitApiKey) env.FACTORY_API_KEY = this.explicitApiKey;
    else delete env.FACTORY_API_KEY;

    return env;
  }

  private resolveDroidPath(): string {
    return resolveDroidPath();
  }
}

/**
 * The legacy DroidSession in @factory/droid-sdk 0.6 has no public send method.
 * Add the daemon's safe-boundary primitive while preserving the session's
 * closed-state invariant at this single provider seam.
 */
export function createFactorySession(session: DroidSession, client: DroidClient): FactorySession {
  let isClosed = false;
  const close = session.close.bind(session);
  return Object.assign(session, {
    send: async (prompt: string, options?: SendOptions): Promise<void> => {
      if (isClosed) throw new Error('Session has been closed. Create a new session to continue.');
      await client.addUserMessage({
        text: prompt,
        ...(options?.images ? { images: options.images } : {}),
        ...(options?.files ? { files: options.files } : {}),
        ...(options?.outputFormat ? { outputFormat: options.outputFormat } : {}),
      });
    },
    close: async (): Promise<void> => {
      if (isClosed) return;
      isClosed = true;
      await close();
    },
  });
}

export function createInitializeSessionParams(
  options: CreateRuntimeSessionOptions,
): InitializeSessionRequestParams & Record<string, unknown> {
  const params: InitializeSessionRequestParams & Record<string, unknown> = {
    machineId: 'default',
    cwd: options.cwd,
    interactionMode: mapInteractionMode(options.interactionMode),
    sessionLocation: 'droid-control',
    tags: tagsFor(options),
  };

  if (options.modelId) params.modelId = options.modelId;
  if (options.reasoningEffort)
    params.reasoningEffort = factoryReasoningEffort(options.reasoningEffort);
  if (options.compactionModel) params.compactionModel = options.compactionModel;
  if (options.compactionTokenLimit !== undefined)
    params.compactionTokenLimit = options.compactionTokenLimit;
  if (options.compactionThresholdCheckEnabled !== undefined)
    params.compactionThresholdCheckEnabled = options.compactionThresholdCheckEnabled;
  if (options.specModeModelId) params.specModeModelId = options.specModeModelId;
  if (options.specModeReasoningEffort)
    params.specModeReasoningEffort = factoryReasoningEffort(options.specModeReasoningEffort);
  if (options.autonomyLevel) params.autonomyLevel = mapAutonomy(options.autonomyLevel);
  if (options.decompSessionType) params.decompSessionType = options.decompSessionType;
  if (options.missionId) params.decompMissionId = options.missionId;
  if (options.mcpServers?.length) params.mcpServers = options.mcpServers;
  const missionSettings = missionSettingsFor(options);
  if (missionSettings) params.missionSettings = missionSettings;

  return params;
}

function mapInteractionMode(mode: SessionInteractionMode): DroidInteractionMode {
  if (mode === 'spec') return DroidInteractionMode.Spec;
  if (mode === 'agi') return DroidInteractionMode.AGI;
  return DroidInteractionMode.Auto;
}

function mapAutonomy(autonomy: Autonomy): AutonomyLevel {
  if (autonomy === 'off') return AutonomyLevel.Off;
  if (autonomy === 'high') return AutonomyLevel.High;
  if (autonomy === 'medium') return AutonomyLevel.Medium;
  return AutonomyLevel.Low;
}

export function factoryReasoningEffort(reasoning: ReasoningEffort): SdkReasoningEffort {
  switch (reasoning) {
    case 'none':
      return SdkReasoningEffort.None;
    case 'dynamic':
      return SdkReasoningEffort.Dynamic;
    case 'off':
      return SdkReasoningEffort.Off;
    case 'minimal':
      return SdkReasoningEffort.Minimal;
    case 'low':
      return SdkReasoningEffort.Low;
    case 'high':
      return SdkReasoningEffort.High;
    case 'xhigh':
      return SdkReasoningEffort.ExtraHigh;
    case 'max':
      return SdkReasoningEffort.Max;
    case 'medium':
    default:
      return SdkReasoningEffort.Medium;
  }
}

function tagsFor(options: CreateRuntimeSessionOptions): InitializeSessionRequestParams['tags'] {
  let kind = 'chat';
  if (options.interactionMode === 'agi') kind = 'mission_orchestrator';
  else if (options.interactionMode === 'spec') kind = 'spec';
  return [
    { name: 'droid-control', metadata: { source: 'droid-control' } },
    { name: 'kind', metadata: { kind } },
    ...(options.missionId
      ? [{ name: 'missionId', metadata: { missionId: options.missionId } }]
      : []),
  ];
}

function missionSettingsFor(
  options: CreateRuntimeSessionOptions,
): Record<string, unknown> | undefined {
  if (
    !options.workerModelId &&
    !options.workerReasoningEffort &&
    !options.validatorModelId &&
    !options.validatorReasoningEffort
  )
    return undefined;
  return {
    ...(options.workerModelId ? { workerModel: options.workerModelId } : {}),
    ...(options.workerReasoningEffort
      ? { workerReasoningEffort: factoryReasoningEffort(options.workerReasoningEffort) }
      : {}),
    ...(options.validatorModelId ? { validationWorkerModel: options.validatorModelId } : {}),
    ...(options.validatorReasoningEffort
      ? {
          validationWorkerReasoningEffort: factoryReasoningEffort(options.validatorReasoningEffort),
        }
      : {}),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Droid ${label} timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
