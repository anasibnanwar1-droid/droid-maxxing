import {
  AutonomyLevel,
  DecompSessionType,
  DroidClient,
  DroidInteractionMode,
  DroidSession,
  ProcessTransport,
  ReasoningEffort as SdkReasoningEffort,
  type AskUserHandler,
  type DroidClientTransport,
  type InitializeSessionRequestParams,
  type LoadSessionRequestParams,
  type PermissionHandler,
} from '@factory/droid-sdk';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Autonomy, ReasoningEffort, SessionInteractionMode } from './protocol.js';

const EXEC_ARGS = ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc'];
const SESSION_INIT_TIMEOUT_MS = 20_000;

export interface RuntimeHandlers {
  permissionHandler?: PermissionHandler;
  askUserHandler?: AskUserHandler;
}

export interface CreateRuntimeSessionOptions extends RuntimeHandlers {
  cwd: string;
  interactionMode: SessionInteractionMode;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  compactionModel?: string;
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

export class DroidRuntime {
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

  async createSession(options: CreateRuntimeSessionOptions): Promise<DroidSession> {
    const { client, transport } = await this.createClient(options.cwd, options);
    const params: InitializeSessionRequestParams & Record<string, unknown> = {
      machineId: 'default',
      cwd: options.cwd,
      interactionMode: mapInteractionMode(options.interactionMode),
      sessionLocation: 'droid-control',
      tags: tagsFor(options),
    };

    if (options.modelId) params.modelId = options.modelId;
    if (options.reasoningEffort) params.reasoningEffort = mapReasoning(options.reasoningEffort);
    if (options.compactionModel && options.compactionModel !== 'current-model') params.compactionModel = options.compactionModel;
    if (options.specModeModelId) params.specModeModelId = options.specModeModelId;
    if (options.specModeReasoningEffort) params.specModeReasoningEffort = mapReasoning(options.specModeReasoningEffort);
    if (options.autonomyLevel) params.autonomyLevel = mapAutonomy(options.autonomyLevel);
    if (options.decompSessionType) params.decompSessionType = options.decompSessionType;
    if (options.missionId) params.decompMissionId = options.missionId;
    const missionSettings = missionSettingsFor(options);
    if (missionSettings) params.missionSettings = missionSettings;

    try {
      const init = await withTimeout(client.initializeSession(params), SESSION_INIT_TIMEOUT_MS, 'initialize_session');
      return new DroidSession(client, init.sessionId, init);
    } catch (err) {
      await transport.close().catch(() => {});
      throw err;
    }
  }

  async loadSession(sessionId: string, handlers: RuntimeHandlers = {}): Promise<DroidSession> {
    const { client, transport } = await this.createClient(undefined, handlers);
    const params: LoadSessionRequestParams = { sessionId };
    try {
      const init = await withTimeout(client.loadSession(params), SESSION_INIT_TIMEOUT_MS, 'load_session');
      return new DroidSession(client, sessionId, init);
    } catch (err) {
      await transport.close().catch(() => {});
      throw err;
    }
  }

  async startCliLogin(): Promise<void> {
    const child = spawn(this.resolveDroidPath(), ['login'], {
      env: this.env(),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  private async createClient(cwd?: string, handlers: RuntimeHandlers = {}): Promise<{ client: DroidClient; transport: DroidClientTransport }> {
    const transport = new ProcessTransport({
      execPath: this.resolveDroidPath(),
      execArgs: EXEC_ARGS,
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
    if (process.env.DROID_PATH) return process.env.DROID_PATH;
    const factoryBin = join(homedir(), '.factory', 'bin', 'droid');
    if (existsSync(factoryBin)) return factoryBin;
    if (existsSync('/opt/homebrew/bin/droid')) return '/opt/homebrew/bin/droid';
    if (existsSync('/usr/local/bin/droid')) return '/usr/local/bin/droid';
    return 'droid';
  }
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
  const kind = options.interactionMode === 'agi' ? 'mission_orchestrator' : options.interactionMode === 'spec' ? 'spec' : 'chat';
  return [
    { name: 'droid-control', metadata: { source: 'droid-control' } },
    { name: 'kind', metadata: { kind } },
    ...(options.missionId ? [{ name: 'missionId', metadata: { missionId: options.missionId } }] : []),
  ];
}

function missionSettingsFor(options: CreateRuntimeSessionOptions): Record<string, unknown> | undefined {
  if (!options.workerModelId && !options.workerReasoningEffort && !options.validatorModelId && !options.validatorReasoningEffort) return undefined;
  return {
    ...(options.workerModelId ? { workerModel: options.workerModelId } : {}),
    ...(options.workerReasoningEffort ? { workerReasoningEffort: mapReasoning(options.workerReasoningEffort) } : {}),
    ...(options.validatorModelId ? { validationWorkerModel: options.validatorModelId } : {}),
    ...(options.validatorReasoningEffort ? { validationWorkerReasoningEffort: mapReasoning(options.validatorReasoningEffort) } : {}),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Droid ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
