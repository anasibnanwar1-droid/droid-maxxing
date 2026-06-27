import {
  AutonomyLevel,
  connectDaemon,
  type DaemonConnection,
  type DaemonSession,
  DecompSessionType,
  DroidClient,
  DroidInteractionMode,
  DroidSession,
  ReasoningEffort as SdkReasoningEffort,
  type AskUserHandler,
  type DroidClientTransport,
  type InitializeSessionRequestParams,
  type LoadSessionRequestParams,
  type McpServerConfig,
  type PermissionHandler,
} from '@factory/droid-sdk';
import { spawn } from 'node:child_process';
import { createDroidTransport } from './DroidTransport.js';
import { buildDroidInvocation, resolveDroidPath } from './Environment.js';
import type { Autonomy, ReasoningEffort, SessionInteractionMode } from './protocol.js';

const EXEC_ARGS = ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc'];
const SESSION_INIT_TIMEOUT_MS = 20_000;

export type RuntimeSession = (DroidSession | DaemonSession) & {
  initResult?: DroidSession['initResult'];
  getContextStats?: DroidSession['getContextStats'];
  getContextBreakdown?: DaemonSession['getContextBreakdown'];
};

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
  specModeModelId?: string;
  specModeReasoningEffort?: ReasoningEffort;
  autonomyLevel?: Autonomy;
  decompSessionType?: DecompSessionType;
  missionId?: string;
  workerModelId?: string;
  workerReasoningEffort?: ReasoningEffort;
  validatorModelId?: string;
  validatorReasoningEffort?: ReasoningEffort;
  mcpServers?: McpServerConfig[];
}

export interface RuntimeStatus {
  mode: 'cli_auth';
  droidPath: string;
  apiKeyConfigured: boolean;
}

export class DroidRuntime {
  private explicitApiKey = '';
  private daemonConnection: DaemonConnection | undefined;

  connect(apiKey?: string): void {
    if (apiKey === undefined) return;
    const nextApiKey = apiKey.trim();
    if (nextApiKey === this.explicitApiKey) return;
    const oldDaemon = this.daemonConnection;
    this.daemonConnection = undefined;
    this.explicitApiKey = nextApiKey;
    void oldDaemon?.close().catch(() => {});
  }

  status(): RuntimeStatus {
    return {
      mode: 'cli_auth',
      droidPath: this.resolveDroidPath(),
      apiKeyConfigured: this.explicitApiKey.length > 0,
    };
  }

  async createSession(options: CreateRuntimeSessionOptions): Promise<RuntimeSession> {
    if (this.explicitApiKey) return this.createDaemonSession(options);
    const { client, transport } = await this.createClient(options.cwd, options);
    const params = createInitializeSessionParams(options);
    let session: RuntimeSession | undefined;

    try {
      const init = await withTimeout(
        client.initializeSession(params),
        SESSION_INIT_TIMEOUT_MS,
        'initialize_session',
      );
      session = new DroidSession(client, init.sessionId, init);
      await applyNativeSessionSettings(session, options);
      return session;
    } catch (err) {
      if (session) await session.close().catch(() => {});
      else await transport.close().catch(() => {});
      throw err;
    }
  }

  async loadSession(sessionId: string, handlers: RuntimeHandlers = {}): Promise<RuntimeSession> {
    if (this.explicitApiKey) return this.loadDaemonSession(sessionId, handlers);
    const { client, transport } = await this.createClient(undefined, handlers);
    const params: LoadSessionRequestParams = { sessionId };
    if (handlers.mcpServers?.length) params.mcpServers = handlers.mcpServers;
    try {
      const init = await withTimeout(
        client.loadSession(params),
        SESSION_INIT_TIMEOUT_MS,
        'load_session',
      );
      return new DroidSession(client, sessionId, init);
    } catch (err) {
      await transport.close().catch(() => {});
      throw err;
    }
  }

  async startCliLogin(): Promise<void> {
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
    child.on('error', () => {});
    child.unref();
  }

  private async createDaemonSession(options: CreateRuntimeSessionOptions): Promise<RuntimeSession> {
    const connection = await this.daemon();
    let session: RuntimeSession | undefined;
    try {
      session = (await connection.createSession({
        cwd: options.cwd,
        interactionMode: mapInteractionMode(options.interactionMode),
        modelId: options.modelId,
        autonomyLevel: options.autonomyLevel ? mapAutonomy(options.autonomyLevel) : undefined,
        reasoningEffort: options.reasoningEffort
          ? mapReasoning(options.reasoningEffort)
          : undefined,
        specModeModelId: options.specModeModelId,
        specModeReasoningEffort: options.specModeReasoningEffort
          ? mapReasoning(options.specModeReasoningEffort)
          : undefined,
        mcpServers: options.mcpServers,
        tags: tagsFor(options),
        permissionHandler: options.permissionHandler,
        askUserHandler: options.askUserHandler,
      } as never)) as RuntimeSession;
      await applyNativeSessionSettings(session, options);
      return session;
    } catch (err) {
      await session?.close().catch(() => {});
      throw err;
    }
  }

  private async loadDaemonSession(
    sessionId: string,
    handlers: RuntimeHandlers = {},
  ): Promise<RuntimeSession> {
    const connection = await this.daemon();
    return (await connection.resumeSession(sessionId, {
      permissionHandler: handlers.permissionHandler,
      askUserHandler: handlers.askUserHandler,
      mcpServers: handlers.mcpServers,
    } as never)) as RuntimeSession;
  }

  private async daemon(): Promise<DaemonConnection> {
    if (!this.explicitApiKey) throw new Error('Factory API key is required for daemon sessions.');
    if (!this.daemonConnection) {
      this.daemonConnection = await connectDaemon({ apiKey: this.explicitApiKey });
    }
    return this.daemonConnection;
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
  if (options.reasoningEffort) params.reasoningEffort = mapReasoning(options.reasoningEffort);
  if (options.compactionModel) params.compactionModel = options.compactionModel;
  params.compactionThresholdCheckEnabled = true;
  if (options.specModeModelId) params.specModeModelId = options.specModeModelId;
  if (options.specModeReasoningEffort)
    params.specModeReasoningEffort = mapReasoning(options.specModeReasoningEffort);
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

function mapReasoning(reasoning: ReasoningEffort): SdkReasoningEffort {
  const values = Object.values(SdkReasoningEffort) as string[];
  return (values.includes(reasoning) ? reasoning : SdkReasoningEffort.Medium) as SdkReasoningEffort;
}

function tagsFor(options: CreateRuntimeSessionOptions): InitializeSessionRequestParams['tags'] {
  const kind =
    options.interactionMode === 'agi'
      ? 'mission_orchestrator'
      : options.interactionMode === 'spec'
        ? 'spec'
        : 'chat';
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
      ? { workerReasoningEffort: mapReasoning(options.workerReasoningEffort) }
      : {}),
    ...(options.validatorModelId ? { validationWorkerModel: options.validatorModelId } : {}),
    ...(options.validatorReasoningEffort
      ? { validationWorkerReasoningEffort: mapReasoning(options.validatorReasoningEffort) }
      : {}),
  };
}

async function applyNativeSessionSettings(
  session: Pick<RuntimeSession, 'updateSettings'>,
  options: CreateRuntimeSessionOptions,
): Promise<void> {
  const settings: Record<string, unknown> = { compactionThresholdCheckEnabled: true };
  if (options.compactionTokenLimit !== undefined)
    settings.compactionTokenLimit = options.compactionTokenLimit;
  const missionSettings = missionSettingsFor(options);
  if (missionSettings) settings.missionSettings = missionSettings;
  await session.updateSettings(settings as never);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Droid ${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
