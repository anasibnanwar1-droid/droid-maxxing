import { createContext, useContext, useReducer, ReactNode, useEffect } from 'react';
import { bridge } from '../lib/bridge';
import { updateCompactionSettings } from '../lib/commands';
import {
  clearDesignMode,
  setDesignMode,
  toggleDesignMode,
  type DesignModes,
} from './designModeState';
import type {
  FactoryDefaultSettings,
  ServerEvent,
  MissionSummary,
  TranscriptEvent,
  ProgressEntry,
  PermissionRequest,
  MissionQuestion,
  ModelInfo,
  WorkerSummary,
  WorkerHistoryLink,
  SkillInfo,
  ReasoningEffort,
  ContextStatsSnapshot,
  SessionKind,
  BrowserState,
  BrowserViewportMode,
  DesignReference,
} from '../types/bridge';
import { addWorkspaceCwd } from '../lib/workspaces';
import { sanitizeForLog } from '../lib/sensitiveLogRedaction';
import { composePrompt } from '../lib/composePrompt';

export type AgentKind = 'orchestrator' | 'worker' | 'validator';
export type LiveEnterBehavior = 'queue' | 'interrupt';

export interface WorkerInfo extends WorkerSummary {
  startedAt: number;
}

export interface QueuedDesignContext {
  browserKey: string;
  references: DesignReference[];
  referenceIds: string[];
}

export interface QueuedPrompt {
  id: string;
  text: string;
  skills: string[];
  files: string[];
  design?: QueuedDesignContext;
}

export interface AgentModelConfig {
  modelId?: string;
  reasoning: ReasoningEffort;
}

export type AgentConfig = Record<AgentKind, AgentModelConfig>;

export interface ThemeConfig {
  mode: 'dark' | 'light' | 'system';
  accent: string;
  bg: string;
  fg: string;
  surface: string;
  border: string;
  uiFont: string;
  uiFontSize: number;
  codeFontSize: number;
  translucentSidebar: boolean;
  diffStyle: 'color' | 'symbol';
  contrast: number;
}

export type SessionRestoreStatus = 'loading' | 'paged' | 'loaded' | 'failed';

export interface SessionRestore {
  status: SessionRestoreStatus;
  loadedCount: number;
  hasMore: boolean;
  error?: string;
}

export interface AppState {
  // Connection
  connection: 'idle' | 'connecting' | 'connected' | 'error';
  connectionError?: string;

  // Missions domain
  missions: Record<string, MissionSummary>;
  missionOrder: string[];
  activeMissionId: string | null;
  transcripts: Record<string, TranscriptEvent[]>;
  progress: Record<string, ProgressEntry[]>;
  workers: Record<string, WorkerInfo[]>; // subagents spawned per mission
  historyLoaded: Record<string, boolean>;
  // Cursor for the next older page of orchestrator scrollback per mission;
  // undefined/absent once the oldest compaction segment has been loaded.
  historyCursor: Record<string, string | undefined>;
  // Whether an older-history page is currently in flight (prevents duplicate
  // prefetches while the user keeps scrolling up).
  historyLoadingOlder: Record<string, boolean>;
  // Explicit transcript-restore state per mission: whether the initial replay
  // is loading, partially loaded (older pages remain), fully loaded, or failed.
  // Lets the chat show an honest restoring/partial/retry surface instead of a
  // blank or silently truncated transcript (#29).
  sessionRestore: Record<string, SessionRestore>;
  // Whether a subagent's inner transcript is currently being fetched, keyed by
  // worker session id. A worker's events only stream after its card is opened,
  // so the view shows a loading state until the first event (or the opened ack)
  // arrives instead of a misleading "no activity" empty state.
  agentHistoryLoading: Record<string, boolean>;
  pendingPermission: PermissionRequest | null;
  pendingQuestion: MissionQuestion | null;
  contextStats: Record<string, ContextStatsSnapshot>;
  specPlans: Record<string, string>; // latest ExitSpecMode plan per session
  // Persisted spec per mission (file path + rendered content). Survives exiting
  // spec mode so the inline card, mermaid, and the wiki reader stay available.
  missionSpecs: Record<string, { path?: string; title: string; content: string }>;
  // Which mission's spec is open in the full wiki reader (null = closed).
  specWikiMissionId: string | null;
  // Held locally until the current turn finishes, then delivered one at a time.
  promptQueue: Record<string, QueuedPrompt[]>;

  // UI flags
  rightPanelOpen: boolean;
  sidebarCollapsed: boolean;
  specMode: boolean;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  // The context-usage popover portals over the app; the native browser view is
  // an OS layer painted above the DOM, so we track this flag to detach the
  // browser while the popover is open (otherwise it renders behind it and
  // swallows outside-click dismissal).
  contextMeterOpen: boolean;
  theme: ThemeConfig;
  missionMode: boolean;
  draftChat: { cwd: string } | null;
  workspaceCwds: string[];
  // Derived (synced by the reducer): whether the browser pane is open for the
  // *currently active* session. Source of truth is `browserOpenKeys`.
  browserOpen: boolean;
  // Per-session browser-pane open state, keyed by browser key (the chat/session
  // id). Presence means "open"; absence means "closed". Persisted so a session
  // resumes where it left off after an app restart, unless it was fully closed.
  browserOpenKeys: Record<string, boolean>;
  browsers: Record<string, BrowserState>;
  browserErrors: Record<string, string>;
  browserGlobalError?: string;
  designModes: DesignModes;

  // Mission Control view
  selectedFeatureId: string | null;
  selectedAgentSessionId: string | null; // 'orchestrator' or worker session id

  // Models / per-agent config
  models: ModelInfo[];
  agentConfig: AgentConfig;

  // Global compaction model applied to every session. 'current-model' = use
  // each session's active model; otherwise a specific model id.
  compactionModel: string;

  // Global default compaction token limit applied to every session. Undefined
  // means "use Factory's model-dependent default".
  compactionTokenLimit?: number;
  // Per-model overrides for the compaction token limit, keyed by model id.
  compactionTokenLimitPerModel: Record<string, number>;
  liveEnterBehavior: LiveEnterBehavior;

  // Per-mission model/reasoning the user picked in the selector. These are
  // authoritative: a stale server summary (e.g. an in-flight resume) must not
  // revert the user's choice back to the session default.
  missionSettingOverrides: Record<string, { modelId?: string; reasoningEffort?: ReasoningEffort }>;

  // Skills catalog (for / invocation)
  skills: SkillInfo[];
  skillsSessionId?: string | null;

  // Attachments for the first message of a not-yet-created mission, keyed by clientRef.
  pendingCompose: Record<string, { text: string; skills: string[]; files: string[] }>;
}

type Action =
  // Connection
  | {
      type: 'SET_CONNECTION';
      status: 'idle' | 'connecting' | 'connected' | 'error';
      message?: string;
    }

  // Mission lifecycle
  | { type: 'MISSION_CREATED'; clientRef: string; mission: MissionSummary }
  | {
      type: 'SET_PENDING_COMPOSE';
      clientRef: string;
      text: string;
      skills: string[];
      files: string[];
    }
  | { type: 'MISSION_UPDATED'; mission: MissionSummary }
  | { type: 'MISSION_FEATURES'; missionId: string; features: MissionSummary['features'] }
  | { type: 'MISSION_PROGRESS'; missionId: string; entries: ProgressEntry[] }
  | {
      type: 'MISSION_WORKER';
      missionId: string;
      event: 'started' | 'updated' | 'completed';
      workerSessionId: string;
      label?: string;
      prompt?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
      toolUseId?: string;
    }
  | {
      type: 'AGENT_UPDATED';
      missionId: string;
      agentSessionId: string;
      role: AgentKind;
      status: 'opened' | 'running' | 'paused' | 'completed';
    }
  | {
      type: 'MISSION_TOKENS';
      missionId: string;
      tokensIn: number;
      tokensOut: number;
      contextTokens: number;
      maxContextTokens?: number;
    }
  | { type: 'CONTEXT_UPDATED'; sessionId: string; stats: ContextStatsSnapshot }
  | { type: 'MISSION_TRANSCRIPT'; event: TranscriptEvent }
  | { type: 'QUEUE_PROMPT'; missionId: string; prompt: QueuedPrompt }
  | { type: 'REMOVE_QUEUED_PROMPT'; missionId: string; id: string }
  | { type: 'REORDER_QUEUE'; missionId: string; from: number; to: number }
  | { type: 'SPEC_SET'; missionId: string; path?: string; title: string; content: string }
  | { type: 'SPEC_OPEN_WIKI'; missionId: string }
  | { type: 'SPEC_CLOSE_WIKI' }
  | { type: 'MISSION_PERMISSION'; request: PermissionRequest }
  | { type: 'MISSION_QUESTION'; question: MissionQuestion }
  | { type: 'MISSION_ERROR'; missionId?: string; message: string }
  | { type: 'MISSION_LIST'; missions: MissionSummary[] }
  | {
      type: 'MISSION_HISTORY';
      missionId: string;
      progress: ProgressEntry[];
      transcripts: TranscriptEvent[];
      workers?: WorkerHistoryLink[];
      mode?: 'replace' | 'prepend';
      olderCursor?: string;
      loadedCount?: number;
      hasMore?: boolean;
    }
  | { type: 'SESSION_RESTORE_START'; missionId: string }
  | { type: 'MISSION_HISTORY_FAILED'; missionId: string; message: string }
  | { type: 'MISSION_HISTORY_LOADING_OLDER'; missionId: string }
  | { type: 'AGENT_HISTORY_LOADING'; agentSessionId: string; loading: boolean }
  | { type: 'CLEAR_PERMISSION' }
  | { type: 'CLEAR_QUESTION' }

  // UI
  | { type: 'SET_ACTIVE_MISSION'; id: string | null }
  | { type: 'SET_RIGHT_PANEL'; open: boolean }
  | { type: 'TOGGLE_COMMAND_PALETTE' }
  | { type: 'CLOSE_COMMAND_PALETTE' }
  | { type: 'SET_CONTEXT_METER_OPEN'; open: boolean }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'TOGGLE_SPEC_MODE' }
  | { type: 'MISSION_SET_KIND'; missionId: string; kind: SessionKind }
  | { type: 'TOGGLE_SETTINGS' }
  | { type: 'TOGGLE_MISSION_MODE' }
  | { type: 'START_CHAT'; cwd: string }
  | { type: 'ADD_WORKSPACE'; cwd: string }
  | { type: 'TOGGLE_BROWSER' }
  | { type: 'SET_BROWSER_OPEN'; open: boolean }
  | { type: 'BROWSER_UPDATED'; browser: BrowserState }
  | { type: 'BROWSER_CLOSED'; missionId: string }
  | { type: 'BROWSER_ERROR'; missionId?: string; message: string }
  | { type: 'TOGGLE_DESIGN_MODE'; sessionId: string }
  | { type: 'SET_DESIGN_MODE'; sessionId: string; open: boolean }
  | { type: 'SET_THEME'; theme: Partial<ThemeConfig> }
  | { type: 'SELECT_FEATURE'; id: string | null }
  | { type: 'SELECT_AGENT'; id: string | null }

  // Models / per-agent config
  | { type: 'MODELS_LIST'; models: ModelInfo[] }
  | { type: 'SKILLS_LIST'; skills: SkillInfo[]; sessionId: string | null }
  | { type: 'FACTORY_DEFAULTS'; defaults: FactoryDefaultSettings }
  | { type: 'SET_AGENT_MODEL'; agent: AgentKind; modelId?: string }
  | { type: 'SET_AGENT_REASONING'; agent: AgentKind; reasoning: ReasoningEffort }
  | { type: 'MISSION_SET_MODEL'; missionId: string; modelId?: string }
  | { type: 'MISSION_SET_REASONING'; missionId: string; reasoning: ReasoningEffort }
  | { type: 'SET_COMPACTION_MODEL_GLOBAL'; compactionModel: string }
  | { type: 'SET_COMPACTION_TOKEN_LIMIT_GLOBAL'; limit?: number }
  | { type: 'SET_COMPACTION_TOKEN_LIMIT_FOR_MODEL'; modelId: string; limit?: number }
  | { type: 'SET_LIVE_ENTER_BEHAVIOR'; behavior: LiveEnterBehavior };

const defaultTheme: ThemeConfig = {
  mode: 'dark',
  accent: '#ee6018',
  bg: '#0a0a0a',
  fg: '#ededed',
  surface: '#111111',
  border: '#1f1f1f',
  uiFont: 'system',
  uiFontSize: 14,
  codeFontSize: 12,
  translucentSidebar: false,
  diffStyle: 'color',
  contrast: 100,
};

const AGENT_CONFIG_STORAGE_KEY = 'droid-agent-config-v2';
const OLD_AGENT_CONFIG_STORAGE_KEYS = ['droid-agent-config'];
const defaultAgentConfig: AgentConfig = {
  orchestrator: { modelId: undefined, reasoning: 'high' },
  worker: { modelId: undefined, reasoning: 'medium' },
  validator: { modelId: undefined, reasoning: 'medium' },
};

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'off' ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'dynamic'
  );
}

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

function loadTheme(): ThemeConfig {
  try {
    const saved = getLocalStorage()?.getItem('droid-theme');
    if (saved) return { ...defaultTheme, ...JSON.parse(saved) };
  } catch {
    /* ignore */
  }
  return defaultTheme;
}

function loadAgentConfig(): AgentConfig {
  try {
    const storage = getLocalStorage();
    if (!storage) return defaultAgentConfig;
    OLD_AGENT_CONFIG_STORAGE_KEYS.forEach((key) => storage.removeItem(key));
    const raw = storage.getItem(AGENT_CONFIG_STORAGE_KEY);
    if (!raw) return defaultAgentConfig;
    const parsed = JSON.parse(raw) as Partial<Record<AgentKind, Partial<AgentModelConfig>>>;
    return {
      orchestrator: readAgentConfig(parsed.orchestrator, defaultAgentConfig.orchestrator),
      worker: readAgentConfig(parsed.worker, defaultAgentConfig.worker),
      validator: readAgentConfig(parsed.validator, defaultAgentConfig.validator),
    };
  } catch {
    return defaultAgentConfig;
  }
}

function readAgentConfig(
  value: Partial<AgentModelConfig> | undefined,
  fallback: AgentModelConfig,
): AgentModelConfig {
  return {
    modelId: typeof value?.modelId === 'string' && value.modelId ? value.modelId : fallback.modelId,
    reasoning: isReasoningEffort(value?.reasoning) ? value.reasoning : fallback.reasoning,
  };
}

function saveAgentConfig(config: AgentConfig): AgentConfig {
  try {
    getLocalStorage()?.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
  return config;
}

// Global compaction model: 'current-model' means each session compacts with
// whatever model it is currently using; otherwise a specific model id is used
// for compaction across every session.
const COMPACTION_MODEL_STORAGE_KEY = 'droid-compaction-model';
const COMPACTION_TOKEN_LIMIT_STORAGE_KEY = 'droid-compaction-token-limit';
const COMPACTION_TOKEN_LIMIT_CONFIGURED_STORAGE_KEY = 'droid-compaction-token-limit-configured';
const COMPACTION_TOKEN_LIMIT_PER_MODEL_STORAGE_KEY = 'droid-compaction-token-limit-per-model';
const LIVE_ENTER_BEHAVIOR_STORAGE_KEY = 'droid-live-enter-behavior';
const WORKSPACES_STORAGE_KEY = 'droid-workspaces';
const UI_STATE_STORAGE_KEY = 'droid-ui-state-v1';
const BROWSER_VIEWPORT_MODES = new Set<BrowserViewportMode>([
  'fit',
  'desktop',
  'laptop',
  'tablet',
  'mobile',
  'custom',
]);

interface PersistedUiState {
  activeMissionId: string | null;
  rightPanelOpen: boolean;
  sidebarCollapsed: boolean;
  specMode: boolean;
  missionMode: boolean;
  browsers: Record<string, BrowserState>;
  browserOpenKeys: Record<string, boolean>;
  selectedFeatureId: string | null;
  selectedAgentSessionId: string | null;
}

function loadCompactionModel(): string {
  try {
    return getLocalStorage()?.getItem(COMPACTION_MODEL_STORAGE_KEY) || 'current-model';
  } catch {
    return 'current-model';
  }
}

function saveCompactionModel(value: string): string {
  try {
    getLocalStorage()?.setItem(COMPACTION_MODEL_STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
  return value;
}

// Only positive finite integers are valid token limits; anything else is
// treated as "unset" (fall back to Factory's model-dependent default).
function normalizeTokenLimit(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function loadCompactionTokenLimit(): number | undefined {
  try {
    return normalizeTokenLimit(getLocalStorage()?.getItem(COMPACTION_TOKEN_LIMIT_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

function hasStoredCompactionTokenLimit(): boolean {
  try {
    const storage = getLocalStorage();
    return (
      storage?.getItem(COMPACTION_TOKEN_LIMIT_STORAGE_KEY) !== null ||
      storage?.getItem(COMPACTION_TOKEN_LIMIT_CONFIGURED_STORAGE_KEY) === '1'
    );
  } catch {
    return false;
  }
}

function saveCompactionTokenLimit(
  value?: number,
  options: { userConfigured?: boolean } = {},
): number | undefined {
  try {
    const storage = getLocalStorage();
    if (value === undefined) storage?.removeItem(COMPACTION_TOKEN_LIMIT_STORAGE_KEY);
    else storage?.setItem(COMPACTION_TOKEN_LIMIT_STORAGE_KEY, String(value));
    if (options.userConfigured ?? true)
      storage?.setItem(COMPACTION_TOKEN_LIMIT_CONFIGURED_STORAGE_KEY, '1');
  } catch {
    /* ignore */
  }
  return value;
}

function loadCompactionTokenLimitPerModel(): Record<string, number> {
  try {
    const raw = getLocalStorage()?.getItem(COMPACTION_TOKEN_LIMIT_PER_MODEL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed)) {
      const n = normalizeTokenLimit(value);
      if (id && n !== undefined) out[id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function hasStoredCompactionTokenLimitPerModel(): boolean {
  try {
    return getLocalStorage()?.getItem(COMPACTION_TOKEN_LIMIT_PER_MODEL_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function saveCompactionTokenLimitPerModel(value: Record<string, number>): Record<string, number> {
  try {
    getLocalStorage()?.setItem(COMPACTION_TOKEN_LIMIT_PER_MODEL_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* ignore */
  }
  return value;
}

function normalizeTokenLimitRecord(
  value: Record<string, number> | undefined,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(([id, limit]) => [id, normalizeTokenLimit(limit)])
      .filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

export function compactionSettingsSnapshot(
  state: Pick<AppState, 'compactionTokenLimit' | 'compactionTokenLimitPerModel'>,
): {
  compactionTokenLimit?: number | null;
  compactionTokenLimitPerModel?: Record<string, number>;
} {
  const snapshot: {
    compactionTokenLimit?: number | null;
    compactionTokenLimitPerModel?: Record<string, number>;
  } = {};
  if (hasStoredCompactionTokenLimit())
    snapshot.compactionTokenLimit = state.compactionTokenLimit ?? null;
  if (hasStoredCompactionTokenLimitPerModel())
    snapshot.compactionTokenLimitPerModel = state.compactionTokenLimitPerModel;
  return snapshot;
}

export function applyFactoryCompactionDefaults(
  state: Pick<AppState, 'compactionTokenLimit' | 'compactionTokenLimitPerModel'>,
  defaults: Pick<FactoryDefaultSettings, 'compactionTokenLimit' | 'compactionTokenLimitPerModel'>,
): Pick<AppState, 'compactionTokenLimit' | 'compactionTokenLimitPerModel'> {
  const hasLocalLimit = hasStoredCompactionTokenLimit();
  const hasLocalPerModel = hasStoredCompactionTokenLimitPerModel();
  const defaultLimit = normalizeTokenLimit(defaults.compactionTokenLimit);
  const defaultPerModel = normalizeTokenLimitRecord(defaults.compactionTokenLimitPerModel);

  const compactionTokenLimit = hasLocalLimit ? state.compactionTokenLimit : defaultLimit;
  const compactionTokenLimitPerModel = hasLocalPerModel
    ? state.compactionTokenLimitPerModel
    : defaultPerModel;

  if (!hasLocalLimit && compactionTokenLimit !== undefined) {
    saveCompactionTokenLimit(compactionTokenLimit, { userConfigured: false });
  }
  if (!hasLocalPerModel && Object.keys(defaultPerModel).length > 0) {
    saveCompactionTokenLimitPerModel(defaultPerModel);
  }

  return { compactionTokenLimit, compactionTokenLimitPerModel };
}

function normalizeLiveEnterBehavior(value: unknown): LiveEnterBehavior {
  return value === 'interrupt' ? 'interrupt' : 'queue';
}

function loadLiveEnterBehavior(): LiveEnterBehavior {
  try {
    return normalizeLiveEnterBehavior(getLocalStorage()?.getItem(LIVE_ENTER_BEHAVIOR_STORAGE_KEY));
  } catch {
    return 'queue';
  }
}

function saveLiveEnterBehavior(value: LiveEnterBehavior): LiveEnterBehavior {
  const behavior = normalizeLiveEnterBehavior(value);
  try {
    getLocalStorage()?.setItem(LIVE_ENTER_BEHAVIOR_STORAGE_KEY, behavior);
  } catch {
    /* ignore */
  }
  return behavior;
}

function loadWorkspaceCwds(): string[] {
  try {
    const raw = getLocalStorage()?.getItem(WORKSPACES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

function saveWorkspaceCwds(cwds: string[]): string[] {
  try {
    getLocalStorage()?.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(cwds));
  } catch {
    /* ignore */
  }
  return cwds;
}

export function loadPersistedUiState(): Partial<PersistedUiState> {
  try {
    const raw = getLocalStorage()?.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedUiState>;
    return {
      activeMissionId: typeof parsed.activeMissionId === 'string' ? parsed.activeMissionId : null,
      rightPanelOpen:
        typeof parsed.rightPanelOpen === 'boolean' ? parsed.rightPanelOpen : undefined,
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === 'boolean' ? parsed.sidebarCollapsed : undefined,
      specMode: typeof parsed.specMode === 'boolean' ? parsed.specMode : undefined,
      missionMode: typeof parsed.missionMode === 'boolean' ? parsed.missionMode : undefined,
      browsers: loadPersistedBrowsers(parsed.browsers),
      browserOpenKeys: loadPersistedBrowserOpenKeys(parsed.browserOpenKeys),
      selectedFeatureId:
        typeof parsed.selectedFeatureId === 'string' ? parsed.selectedFeatureId : null,
      selectedAgentSessionId:
        typeof parsed.selectedAgentSessionId === 'string' ? parsed.selectedAgentSessionId : null,
    };
  } catch {
    return {};
  }
}

function savePersistedUiState(state: AppState): void {
  const snapshot: PersistedUiState = {
    activeMissionId: state.activeMissionId,
    rightPanelOpen: state.rightPanelOpen,
    sidebarCollapsed: state.sidebarCollapsed,
    specMode: state.specMode,
    missionMode: state.missionMode,
    browsers: persistBrowsers(state.browsers),
    browserOpenKeys: state.browserOpenKeys,
    selectedFeatureId: state.selectedFeatureId,
    selectedAgentSessionId: state.selectedAgentSessionId,
  };
  try {
    getLocalStorage()?.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* ignore */
  }
}

function sanitizeAgentConfig(config: AgentConfig, models: ModelInfo[]): AgentConfig {
  if (models.length === 0) return config;
  return {
    orchestrator: sanitizeAgent(config.orchestrator, models),
    worker: sanitizeAgent(config.worker, models),
    validator: sanitizeAgent(config.validator, models),
  };
}

function sanitizeAgent(config: AgentModelConfig, models: ModelInfo[]): AgentModelConfig {
  if (!config.modelId) return config;
  const model = models.find((item) => item.id === config.modelId);
  if (!model) return { modelId: undefined, reasoning: config.reasoning };
  const supported = model.supportedReasoningEfforts;
  if (supported?.length && !supported.includes(config.reasoning)) {
    return { modelId: config.modelId, reasoning: model.defaultReasoningEffort ?? supported[0] };
  }
  if (
    !supported?.length &&
    model.defaultReasoningEffort &&
    config.reasoning !== model.defaultReasoningEffort
  ) {
    return { modelId: config.modelId, reasoning: model.defaultReasoningEffort };
  }
  return config;
}

function applyMissionOverride(
  summary: MissionSummary,
  override?: { modelId?: string; reasoningEffort?: ReasoningEffort },
): MissionSummary {
  if (!override) return summary;
  const next = { ...summary };
  if ('modelId' in override) next.modelId = override.modelId;
  if (override.reasoningEffort !== undefined) next.reasoningEffort = override.reasoningEffort;
  return next;
}

const persistedUiState = loadPersistedUiState();

export const initialState: AppState = {
  connection: 'idle',
  missions: {},
  missionOrder: [],
  activeMissionId: persistedUiState.activeMissionId ?? null,
  transcripts: {},
  progress: {},
  workers: {},
  historyLoaded: {},
  historyCursor: {},
  historyLoadingOlder: {},
  sessionRestore: {},
  agentHistoryLoading: {},
  pendingPermission: null,
  pendingQuestion: null,
  contextStats: {},
  specPlans: {},
  missionSpecs: {},
  specWikiMissionId: null,
  promptQueue: {},
  rightPanelOpen: persistedUiState.rightPanelOpen ?? true,
  sidebarCollapsed: persistedUiState.sidebarCollapsed ?? false,
  specMode: persistedUiState.specMode ?? false,
  settingsOpen: false,
  commandPaletteOpen: false,
  contextMeterOpen: false,
  theme: loadTheme(),
  missionMode: persistedUiState.missionMode ?? false,
  draftChat: null,
  workspaceCwds: loadWorkspaceCwds(),
  browserOpen: false,
  browserOpenKeys: persistedUiState.browserOpenKeys ?? {},
  browsers: persistedUiState.browsers ?? {},
  browserErrors: {},
  browserGlobalError: undefined,
  designModes: {},
  selectedFeatureId: persistedUiState.selectedFeatureId ?? null,
  selectedAgentSessionId: persistedUiState.selectedAgentSessionId ?? null,
  models: [],
  compactionModel: loadCompactionModel(),
  compactionTokenLimit: loadCompactionTokenLimit(),
  compactionTokenLimitPerModel: loadCompactionTokenLimitPerModel(),
  liveEnterBehavior: loadLiveEnterBehavior(),
  missionSettingOverrides: {},
  skills: [],
  skillsSessionId: undefined,
  agentConfig: loadAgentConfig(),
  pendingCompose: {},
};

function progressKey(entry: ProgressEntry): string {
  return `${entry.timestamp}|${entry.type}|${entry.featureId ?? ''}|${entry.workerSessionId ?? ''}|${entry.title ?? ''}`;
}

function activeBrowserKey(state: AppState): string | undefined {
  if (!state.activeMissionId) return undefined;
  // Browser state and open-keys are keyed by the stable app session id
  // (mission.id), matching the backend; the droid sessionId is swapped by
  // compaction and would desync the open state from the backend's updates.
  return state.missions[state.activeMissionId]?.id ?? state.activeMissionId;
}

// Record an explicit open (true) or hidden (false) decision for a browser key.
// Storing `false` (rather than deleting) lets data syncs distinguish a pane the
// user deliberately hid from one that was never opened.
function withBrowserOpenKey(
  keys: Record<string, boolean>,
  key: string,
  open: boolean,
): Record<string, boolean> {
  if (keys[key] === open) return keys;
  return { ...keys, [key]: open };
}

// Forget a browser key entirely (full reset, e.g. session closed). A later
// update then treats the session as never-opened.
function clearBrowserOpenKey(keys: Record<string, boolean>, key: string): Record<string, boolean> {
  if (!(key in keys)) return keys;
  const next = { ...keys };
  delete next[key];
  return next;
}

// One-time upgrade migration for browser state. Panes used to be keyed by the
// volatile droid session id (mission.sessionId, which compaction swaps); they
// are now keyed by the stable app id (mission.id). When missions first load,
// move any persisted entry from a mission's current session id to its stable id
// so an open pane survives the upgrade instead of being orphaned. Stale
// pre-compaction keys (which match no live mission.sessionId) are left behind
// and never read by the new stable-key lookups.
function migrateBrowserStateByMission<T>(
  record: Record<string, T>,
  missions: MissionSummary[],
  rekeyValue: (value: T, stableId: string) => T = (value) => value,
): Record<string, T> {
  let next: Record<string, T> | undefined;
  for (const m of missions) {
    const oldKey = m.sessionId;
    if (!oldKey || oldKey === m.id) continue;
    const source = next ?? record;
    if (source[oldKey] === undefined || source[m.id] !== undefined) continue;
    next = next ?? { ...record };
    next[m.id] = rekeyValue(next[oldKey], m.id);
    delete next[oldKey];
  }
  return next ?? record;
}

// Re-derive `browserOpen` from the per-session open set and the active session.
// Applied after every reducer pass so the convenience flag never goes stale.
// How close in time a live event and a restored page entry must be to count as
// the same (persisted) event. A twin is logged within moments of the live emit,
// while a coincidental same-text repeat is typically much further apart.
const REPLAY_DEDUP_TOLERANCE_MS = 5_000;

// An optimistic user echo stores the raw input, but history persists the
// composed prompt (raw text plus skill/file context). Match against both so a
// skill/file prompt is recognized as superseded instead of duplicating.
function echoMatchesPersisted(e: TranscriptEvent, persisted: Set<string | undefined>): boolean {
  if (!e.text) return false;
  if (persisted.has(e.text)) return true;
  const composed = composePrompt(e.text, e.skills ?? [], e.files ?? []);
  return composed !== e.text && persisted.has(composed);
}

function syncBrowserOpen(state: AppState): AppState {
  const key = activeBrowserKey(state);
  const open = key ? Boolean(state.browserOpenKeys[key]) : false;
  return state.browserOpen === open ? state : { ...state, browserOpen: open };
}

export function reducer(state: AppState, action: Action): AppState {
  return syncBrowserOpen(baseReducer(state, action));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Merge a streamed tool_call delta's args onto the accumulated args. One tool
// call streams as many partial deltas: a Task spawn sends subagent_type and
// description in separate deltas, and Todo/edit deltas can be payload-less or
// carry only some fields. Replacing wholesale would drop earlier-streamed
// fields, so shallow-merge when both are objects (latest field value wins) and
// only fall back to a non-object/absent delta when there is nothing to merge.
function mergeToolArgs(prev: unknown, next: unknown): unknown {
  if (isPlainRecord(prev) && isPlainRecord(next)) return { ...prev, ...next };
  return next ?? prev;
}

function baseReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_CONNECTION':
      return { ...state, connection: action.status, connectionError: action.message };

    case 'MISSION_CREATED': {
      const order = state.missionOrder.includes(action.mission.id)
        ? state.missionOrder
        : [action.mission.id, ...state.missionOrder];

      // Seed the first user message: the goal is the user's opening prompt and the
      // backend never echoes it back, so without this the first message never shows.
      let transcripts = state.transcripts;
      const hasTranscript = (state.transcripts[action.mission.id]?.length ?? 0) > 0;
      const pending = state.pendingCompose[action.clientRef];
      if (action.mission.goal && !hasTranscript) {
        const seed: TranscriptEvent = {
          id: `seed-${action.mission.id}`,
          missionId: action.mission.id,
          agentSessionId: 'user',
          role: 'orchestrator',
          ts: action.mission.createdAt || Date.now(),
          kind: 'text',
          text: pending ? pending.text : action.mission.goal,
          author: 'user',
          skills: pending?.skills.length ? pending.skills : undefined,
          files: pending?.files.length ? pending.files : undefined,
        };
        transcripts = { ...state.transcripts, [action.mission.id]: [seed] };
      }

      const pendingCompose = pending
        ? Object.fromEntries(
            Object.entries(state.pendingCompose).filter(([k]) => k !== action.clientRef),
          )
        : state.pendingCompose;

      const next = {
        ...state,
        missions: {
          ...state.missions,
          [action.mission.id]: applyMissionOverride(
            action.mission,
            state.missionSettingOverrides[action.mission.id],
          ),
        },
        missionOrder: order,
        transcripts,
        activeMissionId: action.mission.id,
        draftChat: null,
        pendingCompose,
      };
      return next;
    }

    case 'SET_PENDING_COMPOSE':
      return {
        ...state,
        pendingCompose: {
          ...state.pendingCompose,
          [action.clientRef]: { text: action.text, skills: action.skills, files: action.files },
        },
      };

    case 'MISSION_UPDATED': {
      const previous = state.missions[action.mission.id];
      const m = applyMissionOverride(
        action.mission,
        state.missionSettingOverrides[action.mission.id],
      );
      const previousCompactions =
        (previous?.compactedFromSessionIds?.length ?? 0) + (previous?.autoCompactions ?? 0);
      const nextCompactions = (m.compactedFromSessionIds?.length ?? 0) + (m.autoCompactions ?? 0);
      const contextStats =
        nextCompactions > previousCompactions && state.contextStats[m.id]
          ? Object.fromEntries(
              Object.entries(state.contextStats).filter(([sessionId]) => sessionId !== m.id),
            )
          : state.contextStats;
      return {
        ...state,
        missions: { ...state.missions, [m.id]: m },
        contextStats,
      };
    }

    case 'MISSION_FEATURES': {
      const mid = action.missionId;
      const existing = state.missions[mid];
      if (!existing) return state;
      return {
        ...state,
        missions: { ...state.missions, [mid]: { ...existing, features: action.features } },
      };
    }

    case 'MISSION_PROGRESS': {
      const mid = action.missionId;
      const prev = state.progress[mid] ?? [];
      const seen = new Set(prev.map(progressKey));
      const next = [...prev];
      action.entries.forEach((entry) => {
        const key = progressKey(entry);
        if (seen.has(key)) return;
        seen.add(key);
        next.push(entry);
      });
      return {
        ...state,
        progress: { ...state.progress, [mid]: next },
      };
    }

    case 'MISSION_WORKER': {
      const mid = action.missionId;
      const prev = state.workers[mid] ?? [];
      const idx = prev.findIndex((w) => w.sessionId === action.workerSessionId);
      let next: WorkerInfo[];
      if (idx >= 0) {
        next = [...prev];
        next[idx] = {
          ...next[idx],
          status:
            action.event === 'completed'
              ? 'completed'
              : action.event === 'updated'
                ? next[idx].status
                : 'running',
          label: action.label ?? next[idx].label,
          prompt: action.prompt ?? next[idx].prompt,
          modelId: action.modelId ?? next[idx].modelId,
          reasoningEffort: action.reasoningEffort ?? next[idx].reasoningEffort,
          toolUseId: action.toolUseId ?? next[idx].toolUseId,
        };
      } else {
        if (action.event === 'updated') return state;
        next = [
          ...prev,
          {
            sessionId: action.workerSessionId,
            status: action.event === 'completed' ? 'completed' : 'running',
            startedAt: Date.now(),
            label: action.label,
            prompt: action.prompt,
            modelId: action.modelId,
            reasoningEffort: action.reasoningEffort,
            toolUseId: action.toolUseId,
          },
        ];
      }
      return { ...state, workers: { ...state.workers, [mid]: next } };
    }

    case 'AGENT_HISTORY_LOADING': {
      if ((state.agentHistoryLoading[action.agentSessionId] ?? false) === action.loading)
        return state;
      return {
        ...state,
        agentHistoryLoading: {
          ...state.agentHistoryLoading,
          [action.agentSessionId]: action.loading,
        },
      };
    }

    case 'AGENT_UPDATED': {
      // The 'opened' ack fires after a worker's history replay completes (even
      // when nothing was captured), so it reliably ends the loading state.
      const base =
        action.status === 'opened' && state.agentHistoryLoading[action.agentSessionId]
          ? {
              ...state,
              agentHistoryLoading: {
                ...state.agentHistoryLoading,
                [action.agentSessionId]: false,
              },
            }
          : state;
      if (action.role !== 'worker' || action.status === 'opened') return base;
      // Past this point status is running/paused/completed, so base === state.
      const prev = state.workers[action.missionId] ?? [];
      const idx = prev.findIndex((w) => w.sessionId === action.agentSessionId);
      if (idx < 0) return state;
      const next = [...prev];
      next[idx] = { ...next[idx], status: action.status };
      return { ...state, workers: { ...state.workers, [action.missionId]: next } };
    }

    case 'MISSION_TOKENS': {
      const mid = action.missionId;
      const existing = state.missions[mid];
      if (!existing) return state;
      return {
        ...state,
        missions: {
          ...state.missions,
          [mid]: {
            ...existing,
            tokensIn: action.tokensIn,
            tokensOut: action.tokensOut,
            contextTokens: action.contextTokens,
            maxContextTokens: action.maxContextTokens ?? existing.maxContextTokens,
          },
        },
      };
    }

    case 'CONTEXT_UPDATED': {
      const existing = state.missions[action.sessionId];
      return {
        ...state,
        contextStats: { ...state.contextStats, [action.sessionId]: action.stats },
        missions: existing
          ? {
              ...state.missions,
              [action.sessionId]: {
                ...existing,
                contextTokens: action.stats.used,
                contextRemainingTokens: action.stats.remaining,
                maxContextTokens: action.stats.limit,
                contextAccuracy: action.stats.accuracy,
                contextUpdatedAt: action.stats.updatedAt,
              },
            }
          : state.missions,
      };
    }

    case 'MISSION_TRANSCRIPT': {
      const ev = action.event;
      const mid = ev.missionId;
      const prev = state.transcripts[mid] ?? [];
      if (prev.some((event) => event.id === ev.id)) return state;

      // Delta merging: if last event has same kind + agentSessionId, append text
      // Only merge backend streaming deltas (author is absent); do NOT merge explicit user echoes
      const last = prev[prev.length - 1];
      if (
        last &&
        !ev.author && // backend streaming delta (user echoes have author:'user')
        last.kind === ev.kind &&
        last.agentSessionId === ev.agentSessionId &&
        last.author === ev.author &&
        (ev.kind === 'text' || ev.kind === 'thinking') &&
        ev.text &&
        !ev.toolName
      ) {
        const merged = [...prev];
        merged[merged.length - 1] = { ...last, text: (last.text ?? '') + ev.text, endTs: ev.ts };
        return { ...state, transcripts: { ...state.transcripts, [mid]: merged } };
      }

      // Coalesce tool_call deltas: a single tool call streams as many partial
      // tool_call events sharing one toolUseId. Collapse them onto the prior
      // event (keeping its stable id, adopting the latest args) so live render
      // matches replay's one-event-per-tool-use shape and edit stats are not
      // inflated by counting every partial snapshot.
      if (
        last &&
        !ev.author &&
        ev.kind === 'tool_call' &&
        last.kind === 'tool_call' &&
        last.agentSessionId === ev.agentSessionId &&
        !!ev.toolUseId &&
        last.toolUseId === ev.toolUseId
      ) {
        const merged = [...prev];
        merged[merged.length - 1] = {
          ...last,
          toolName: ev.toolName ?? last.toolName,
          toolArgs: mergeToolArgs(last.toolArgs, ev.toolArgs),
          endTs: ev.ts,
        };
        return { ...state, transcripts: { ...state.transcripts, [mid]: merged } };
      }

      return {
        ...state,
        transcripts: { ...state.transcripts, [mid]: [...prev, ev] },
      };
    }

    case 'QUEUE_PROMPT': {
      const prev = state.promptQueue[action.missionId] ?? [];
      return {
        ...state,
        promptQueue: { ...state.promptQueue, [action.missionId]: [...prev, action.prompt] },
      };
    }

    case 'REMOVE_QUEUED_PROMPT': {
      const prev = state.promptQueue[action.missionId] ?? [];
      return {
        ...state,
        promptQueue: {
          ...state.promptQueue,
          [action.missionId]: prev.filter((p) => p.id !== action.id),
        },
      };
    }

    case 'REORDER_QUEUE': {
      const prev = state.promptQueue[action.missionId] ?? [];
      if (
        action.from === action.to ||
        action.from < 0 ||
        action.to < 0 ||
        action.from >= prev.length ||
        action.to >= prev.length
      ) {
        return state;
      }
      const next = [...prev];
      const [moved] = next.splice(action.from, 1);
      next.splice(action.to, 0, moved);
      return { ...state, promptQueue: { ...state.promptQueue, [action.missionId]: next } };
    }

    case 'SPEC_SET': {
      const prev = state.missionSpecs[action.missionId];
      if (
        prev &&
        prev.content === action.content &&
        prev.path === action.path &&
        prev.title === action.title
      ) {
        return state;
      }
      return {
        ...state,
        missionSpecs: {
          ...state.missionSpecs,
          [action.missionId]: { path: action.path, title: action.title, content: action.content },
        },
      };
    }

    case 'SPEC_OPEN_WIKI':
      return { ...state, specWikiMissionId: action.missionId };

    case 'SPEC_CLOSE_WIKI':
      return { ...state, specWikiMissionId: null };

    case 'MISSION_PERMISSION': {
      const r = action.request;
      const specPlans =
        r.kind === 'spec' && r.plan
          ? { ...state.specPlans, [r.missionId]: r.plan }
          : state.specPlans;
      // Seed the persistent spec/plan so the inline card and wiki reader work
      // immediately (a richer spec file, if any, overrides this via SPEC_SET).
      // Seed/refresh the persistent spec whenever a (revised) plan arrives so the
      // card/wiki never go stale. The path is preserved; ChatView reloads the
      // file on revision and overrides with the richer on-disk content.
      const existingSpec = state.missionSpecs[r.missionId];
      const missionSpecs =
        (r.kind === 'spec' || r.kind === 'mission_plan') &&
        r.plan &&
        existingSpec?.content !== r.plan
          ? {
              ...state.missionSpecs,
              [r.missionId]: { path: existingSpec?.path, title: r.title, content: r.plan },
            }
          : state.missionSpecs;
      return { ...state, pendingPermission: r, specPlans, missionSpecs };
    }

    case 'MISSION_QUESTION':
      return { ...state, pendingQuestion: action.question };

    case 'MISSION_ERROR': {
      if (action.missionId && state.missions[action.missionId]) {
        const m = state.missions[action.missionId];
        return {
          ...state,
          missions: { ...state.missions, [action.missionId]: { ...m, phase: 'failed' as const } },
        };
      }
      return state;
    }

    case 'MISSION_LIST': {
      const map: Record<string, MissionSummary> = { ...state.missions };
      for (const m of action.missions) {
        map[m.id] = applyMissionOverride(m, state.missionSettingOverrides[m.id]);
      }
      const order = [...new Set([...action.missions.map((m) => m.id), ...state.missionOrder])]
        .filter((id) => map[id])
        .sort((a, b) => map[b].updatedAt - map[a].updatedAt);
      return {
        ...state,
        missions: map,
        missionOrder: order,
        // Carry any pre-upgrade browser panes from the old session-id key to the
        // stable mission id so a re-keyed/compacted session keeps its open pane.
        browsers: migrateBrowserStateByMission(state.browsers, action.missions, (b, id) => ({
          ...b,
          missionId: id,
        })),
        browserOpenKeys: migrateBrowserStateByMission(state.browserOpenKeys, action.missions),
        activeMissionId:
          state.activeMissionId && map[state.activeMissionId]
            ? state.activeMissionId
            : state.activeMissionId,
      };
    }

    case 'MISSION_HISTORY_LOADING_OLDER':
      return {
        ...state,
        historyLoadingOlder: { ...state.historyLoadingOlder, [action.missionId]: true },
      };

    case 'SESSION_RESTORE_START': {
      const prev = state.sessionRestore[action.missionId];
      return {
        ...state,
        sessionRestore: {
          ...state.sessionRestore,
          [action.missionId]: {
            status: 'loading',
            loadedCount: prev?.loadedCount ?? 0,
            hasMore: prev?.hasMore ?? false,
          },
        },
      };
    }

    case 'MISSION_HISTORY_FAILED': {
      const prev = state.sessionRestore[action.missionId];
      return {
        ...state,
        sessionRestore: {
          ...state.sessionRestore,
          [action.missionId]: {
            status: 'failed',
            loadedCount: prev?.loadedCount ?? 0,
            hasMore: prev?.hasMore ?? false,
            error: action.message,
          },
        },
      };
    }

    case 'MISSION_HISTORY': {
      const existing = state.transcripts[action.missionId] ?? [];
      // An older page prepends its events to the front of the existing scrollback
      // (deduping by id so a trimmed/overlapping boundary never doubles a message).
      if (action.mode === 'prepend') {
        // Drop optimistic user echoes (seed-/local-) now superseded by the real
        // persisted prompt arriving in this older page. They were kept above a
        // partial page during the initial restore; without this they would
        // duplicate and misorder the opening prompt once it pages in (their ids
        // differ from the persisted prompt, so id-dedup alone misses them).
        const olderUserText = new Set(
          action.transcripts.filter((e) => e.author === 'user' && e.text).map((e) => e.text),
        );
        const olderLastTs =
          action.transcripts.length > 0 ? action.transcripts[action.transcripts.length - 1].ts : 0;
        const supersededEcho = (e: TranscriptEvent) =>
          (e.id.startsWith('seed-') || e.id.startsWith('local-')) &&
          e.author === 'user' &&
          !!e.text &&
          e.ts <= olderLastTs &&
          echoMatchesPersisted(e, olderUserText);
        const kept = existing.filter((e) => !supersededEcho(e));
        const have = new Set(kept.map((e) => e.id));
        const older = action.transcripts.filter((e) => !have.has(e.id));
        const changed = older.length > 0 || kept.length !== existing.length;
        const merged = changed ? [...older, ...kept] : existing;
        const hasMore = Boolean(action.olderCursor);
        return {
          ...state,
          transcripts: changed
            ? { ...state.transcripts, [action.missionId]: merged }
            : state.transcripts,
          historyCursor: { ...state.historyCursor, [action.missionId]: action.olderCursor },
          historyLoadingOlder: { ...state.historyLoadingOlder, [action.missionId]: false },
          sessionRestore: {
            ...state.sessionRestore,
            [action.missionId]: {
              status: hasMore ? 'paged' : 'loaded',
              loadedCount: merged.length,
              hasMore,
            },
          },
        };
      }
      // No-clobber replace: reconcile the authoritative, correctly-ordered
      // replay page with any live events already in state (a reconnect to a
      // running mission can deliver live mission.transcript events first, and a
      // brand-new mission carries a locally-seeded opening prompt).
      //   - Shared ids: the page wins.
      //   - Optimistic user echoes (seed-/local- ids) the page already contains
      //     (matched by author + text within the page's time window) are dropped
      //     so the opening prompt never double-renders once history arrives.
      //     Echoes newer than the whole page (a prompt sent during restore) are
      //     kept, as are echoes older than a PARTIAL page (paged restore): there
      //     the matching text is a later message, not this echo, so dropping it
      //     would lose the opening prompt that belongs above the page.
      //   - Live events that duplicate a replayed one by content are dropped:
      //     live ids are transient (nextId) and live ts is receipt-time, so a
      //     reconnect-race event and its persisted twin share neither id nor ts
      //     and would otherwise both render. They are matched by a content
      //     signature (agentSessionId + toolUseId for tools, else
      //     agentSessionId + author/role + kind + text) consumed once per page
      //     occurrence so a genuinely repeated message is kept. Scoping by
      //     agentSessionId stops one worker's output from masking another's.
      //   - Remaining live-only events keep their place by timestamp relative to
      //     the page: an un-persisted opening prompt stays above it, a just-sent
      //     prompt (reconnect race) stays below it.
      // The page's internal order (seq) is preserved by never re-sorting it.
      const page = action.transcripts;
      const pageIds = new Set(page.map((e) => e.id));
      const pageUserText = new Set(
        page.filter((e) => e.author === 'user' && e.text).map((e) => e.text),
      );
      const firstTs = page.length > 0 ? page[0].ts : 0;
      const lastTs = page.length > 0 ? page[page.length - 1].ts : 0;
      // A partial page (older history still pages in) does not contain anything
      // older than firstTs, so an earlier echo must not be deduped against it.
      // A complete page (no older cursor) spans the whole conversation, so the
      // lower bound is relaxed to also catch a seed whose createdAt slightly
      // predates the first persisted message.
      const pageIsComplete = !action.olderCursor;
      const supersededEcho = (e: TranscriptEvent) =>
        (e.id.startsWith('seed-') || e.id.startsWith('local-')) &&
        e.author === 'user' &&
        !!e.text &&
        e.ts <= lastTs &&
        (pageIsComplete || e.ts >= firstTs) &&
        echoMatchesPersisted(e, pageUserText);
      // Live orchestrator events carry agentSessionId = appSessionId while the
      // restored history canonicalizes it to 'orchestrator' (mirroring the
      // sidecar). Normalize so a reconnect-race twin matches instead of both the
      // live and persisted copy surviving and duplicating main-agent output.
      const sessionKey = (e: TranscriptEvent) =>
        e.role === 'orchestrator' && e.agentSessionId !== 'user'
          ? 'orchestrator'
          : e.agentSessionId;
      const contentSig = (e: TranscriptEvent) =>
        e.toolUseId
          ? `tool:${sessionKey(e)}:${e.kind}:${e.toolUseId}`
          : `${sessionKey(e)}:${e.author ?? e.role}:${e.kind}:${e.text ?? ''}`;
      // Index page entries by content signature -> their timestamps so a live
      // event is matched to the persisted twin nearest in time rather than to
      // any same-text occurrence anywhere in restored history.
      const pageSig = new Map<string, number[]>();
      for (const e of page) {
        const k = contentSig(e);
        const at = pageSig.get(k);
        if (at) at.push(e.ts);
        else pageSig.set(k, [e.ts]);
      }
      const isReplayedDuplicate = (e: TranscriptEvent) => {
        // Optimistic user echoes are governed solely by supersededEcho above; do
        // not let content-dedup drop one the echo logic intentionally keeps.
        if (e.id.startsWith('seed-') || e.id.startsWith('local-')) return false;
        const at = pageSig.get(contentSig(e));
        if (!at || at.length === 0) return false;
        // A persisted twin is logged within moments of the live event; a page
        // entry far from this event's time is a different occurrence (e.g. a
        // repeated "ok"). Consume only the closest twin within tolerance so a
        // brand-new live output that merely repeats old text is never dropped.
        // Streamed text/thinking keep the first-chunk ts but advance endTs, while
        // history timestamps near completion, so compare against the whole live
        // [ts, endTs] span rather than just the start.
        const lo = Math.min(e.ts, e.endTs ?? e.ts);
        const hi = Math.max(e.ts, e.endTs ?? e.ts);
        let bestIdx = -1;
        let bestDiff = Infinity;
        for (let i = 0; i < at.length; i++) {
          const t = at[i];
          const diff = t < lo ? lo - t : t > hi ? t - hi : 0;
          if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0 && bestDiff <= REPLAY_DEDUP_TOLERANCE_MS) {
          at.splice(bestIdx, 1);
          return true;
        }
        return false;
      };
      const liveOnly = existing.filter(
        (e) => !pageIds.has(e.id) && !supersededEcho(e) && !isReplayedDuplicate(e),
      );
      const before = liveOnly.filter((e) => e.ts < firstTs);
      const after = liveOnly.filter((e) => e.ts >= firstTs);
      const mergedTranscript = page.length > 0 ? [...before, ...page, ...after] : existing;
      const transcripts = { ...state.transcripts, [action.missionId]: mergedTranscript };
      // Merge the exact spawn->worker mapping from history with any live workers
      // already in state (a live mission.worker may arrive before history). Live
      // entries win; history links add missing workers and backfill toolUseId.
      const histLinks = action.workers ?? [];
      const existingWorkers = state.workers[action.missionId] ?? [];
      let workers = state.workers;
      if (histLinks.length > 0) {
        const bySession = new Map(existingWorkers.map((w) => [w.sessionId, w]));
        let changed = false;
        for (const link of histLinks) {
          const existing = bySession.get(link.workerSessionId);
          if (!existing) {
            bySession.set(link.workerSessionId, {
              sessionId: link.workerSessionId,
              // Honor the live run state the backend attaches for active
              // missions so a reconnect/reload doesn't mark a still-running
              // subagent as finished; historical loads omit it (-> completed).
              status: link.status ?? 'completed',
              // A running link has no persisted start time; seed "now" so the
              // elapsed timer counts from reconnect rather than the Unix epoch.
              // Completed links don't render a timer, so 0 is fine.
              startedAt: link.status === 'running' ? Date.now() : 0,
              label: link.label,
              toolUseId: link.toolUseId,
            });
            changed = true;
          } else if (existing.toolUseId === undefined && link.toolUseId !== undefined) {
            bySession.set(link.workerSessionId, {
              ...existing,
              toolUseId: link.toolUseId,
              label: existing.label ?? link.label,
            });
            changed = true;
          }
        }
        if (changed)
          workers = { ...state.workers, [action.missionId]: Array.from(bySession.values()) };
      }
      const hasMore = Boolean(action.olderCursor);
      // An empty restore (e.g. a live mission with no persisted history yet)
      // must not wipe progress already delivered by live events; only adopt the
      // replayed progress when it actually carries entries.
      const existingProgress = state.progress[action.missionId] ?? [];
      const mergedProgress = action.progress.length > 0 ? action.progress : existingProgress;
      return {
        ...state,
        progress: { ...state.progress, [action.missionId]: mergedProgress },
        transcripts,
        workers,
        historyLoaded: { ...state.historyLoaded, [action.missionId]: true },
        historyCursor: { ...state.historyCursor, [action.missionId]: action.olderCursor },
        historyLoadingOlder: { ...state.historyLoadingOlder, [action.missionId]: false },
        sessionRestore: {
          ...state.sessionRestore,
          [action.missionId]: {
            status: hasMore ? 'paged' : 'loaded',
            loadedCount: mergedTranscript.length,
            hasMore,
          },
        },
      };
    }

    case 'CLEAR_PERMISSION':
      return { ...state, pendingPermission: null };

    case 'CLEAR_QUESTION':
      return { ...state, pendingQuestion: null };

    case 'SET_ACTIVE_MISSION':
      return {
        ...state,
        activeMissionId: action.id,
        draftChat: null,
        selectedAgentSessionId: null,
      };

    case 'SET_RIGHT_PANEL':
      return { ...state, rightPanelOpen: action.open };

    case 'TOGGLE_COMMAND_PALETTE':
      return { ...state, commandPaletteOpen: !state.commandPaletteOpen };

    case 'CLOSE_COMMAND_PALETTE':
      return { ...state, commandPaletteOpen: false };

    case 'SET_CONTEXT_METER_OPEN':
      return { ...state, contextMeterOpen: action.open };

    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };

    case 'TOGGLE_SPEC_MODE':
      return { ...state, specMode: !state.specMode };

    case 'MISSION_SET_KIND': {
      // Optimistic interaction-mode flip so the spec toggle reflects instantly;
      // a later MISSION_UPDATED from the backend confirms (or corrects) it.
      const m = state.missions[action.missionId];
      if (!m || m.kind === action.kind) return state;
      return {
        ...state,
        missions: { ...state.missions, [action.missionId]: { ...m, kind: action.kind } },
      };
    }

    case 'TOGGLE_SETTINGS':
      return { ...state, settingsOpen: !state.settingsOpen };

    case 'TOGGLE_MISSION_MODE':
      return { ...state, missionMode: !state.missionMode };

    case 'START_CHAT':
      return {
        ...state,
        draftChat: { cwd: action.cwd },
        activeMissionId: null,
        missionMode: false,
      };

    case 'ADD_WORKSPACE':
      return {
        ...state,
        workspaceCwds: saveWorkspaceCwds(addWorkspaceCwd(state.workspaceCwds, action.cwd)),
      };

    case 'TOGGLE_BROWSER': {
      const key = activeBrowserKey(state);
      if (!key) return state;
      return {
        ...state,
        browserOpenKeys: withBrowserOpenKey(
          state.browserOpenKeys,
          key,
          !state.browserOpenKeys[key],
        ),
      };
    }

    case 'SET_BROWSER_OPEN': {
      const key = activeBrowserKey(state);
      if (!key) return state;
      return {
        ...state,
        browserOpenKeys: withBrowserOpenKey(state.browserOpenKeys, key, action.open),
      };
    }

    case 'BROWSER_UPDATED': {
      if (!action.browser.missionId) return state;
      const missionId = action.browser.missionId;
      // Surface a freshly opened browser, but never re-open a pane the user hid.
      const hidden = state.browserOpenKeys[missionId] === false;
      return {
        ...state,
        browsers: { ...state.browsers, [missionId]: action.browser },
        browserErrors: Object.fromEntries(
          Object.entries(state.browserErrors).filter(([id]) => id !== missionId),
        ),
        browserOpenKeys: hidden
          ? state.browserOpenKeys
          : withBrowserOpenKey(state.browserOpenKeys, missionId, true),
      };
    }

    case 'BROWSER_CLOSED':
      // Full close: drop the session's browser, design mode, and open flag so a
      // later reopen starts fresh (and it is excluded from persistence).
      return {
        ...state,
        browsers: Object.fromEntries(
          Object.entries(state.browsers).filter(([id]) => id !== action.missionId),
        ),
        browserErrors: Object.fromEntries(
          Object.entries(state.browserErrors).filter(([id]) => id !== action.missionId),
        ),
        designModes: clearDesignMode(state.designModes, action.missionId),
        browserOpenKeys: clearBrowserOpenKey(state.browserOpenKeys, action.missionId),
      };

    case 'BROWSER_ERROR':
      if (!action.missionId) return { ...state, browserGlobalError: action.message };
      return {
        ...state,
        browserErrors: { ...state.browserErrors, [action.missionId]: action.message },
        // Respect an explicit hide; otherwise surface the errored browser.
        browserOpenKeys:
          state.browserOpenKeys[action.missionId] === false
            ? state.browserOpenKeys
            : withBrowserOpenKey(state.browserOpenKeys, action.missionId, true),
      };

    case 'TOGGLE_DESIGN_MODE':
      return { ...state, designModes: toggleDesignMode(state.designModes, action.sessionId) };

    case 'SET_DESIGN_MODE':
      return {
        ...state,
        designModes: setDesignMode(state.designModes, action.sessionId, action.open),
      };

    case 'SET_THEME': {
      const next = { ...state.theme, ...action.theme };
      try {
        getLocalStorage()?.setItem('droid-theme', JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return { ...state, theme: next };
    }

    case 'SELECT_FEATURE':
      return { ...state, selectedFeatureId: action.id };

    case 'SELECT_AGENT':
      return { ...state, selectedAgentSessionId: action.id };

    case 'MODELS_LIST':
      return {
        ...state,
        models: action.models,
        agentConfig: saveAgentConfig(sanitizeAgentConfig(state.agentConfig, action.models)),
      };

    case 'SKILLS_LIST':
      return { ...state, skills: action.skills, skillsSessionId: action.sessionId };

    case 'FACTORY_DEFAULTS': {
      const next = sanitizeAgentConfig(
        {
          orchestrator: {
            modelId: state.agentConfig.orchestrator.modelId ?? action.defaults.modelId,
            reasoning: state.agentConfig.orchestrator.modelId
              ? state.agentConfig.orchestrator.reasoning
              : (action.defaults.reasoningEffort ?? state.agentConfig.orchestrator.reasoning),
          },
          worker: {
            modelId: state.agentConfig.worker.modelId ?? action.defaults.workerModelId,
            reasoning: state.agentConfig.worker.modelId
              ? state.agentConfig.worker.reasoning
              : (action.defaults.workerReasoningEffort ?? state.agentConfig.worker.reasoning),
          },
          validator: {
            modelId: state.agentConfig.validator.modelId ?? action.defaults.validatorModelId,
            reasoning: state.agentConfig.validator.modelId
              ? state.agentConfig.validator.reasoning
              : (action.defaults.validatorReasoningEffort ?? state.agentConfig.validator.reasoning),
          },
        },
        state.models,
      );

      // Seed Factory defaults only before local compaction settings exist. An
      // explicit clear stores an empty local value and must not resurrect
      // Factory's old per-model/default threshold on the next defaults event.
      const compactionDefaults = applyFactoryCompactionDefaults(state, action.defaults);

      return {
        ...state,
        agentConfig: saveAgentConfig(next),
        ...compactionDefaults,
      };
    }

    case 'SET_AGENT_MODEL':
      return {
        ...state,
        agentConfig: saveAgentConfig({
          ...state.agentConfig,
          [action.agent]: { ...state.agentConfig[action.agent], modelId: action.modelId },
        }),
      };

    case 'SET_AGENT_REASONING':
      return {
        ...state,
        agentConfig: saveAgentConfig({
          ...state.agentConfig,
          [action.agent]: { ...state.agentConfig[action.agent], reasoning: action.reasoning },
        }),
      };

    case 'MISSION_SET_MODEL': {
      const m = state.missions[action.missionId];
      if (!m) return state;
      const prevOverride = state.missionSettingOverrides[action.missionId] ?? {};
      return {
        ...state,
        missions: { ...state.missions, [action.missionId]: { ...m, modelId: action.modelId } },
        missionSettingOverrides: {
          ...state.missionSettingOverrides,
          [action.missionId]: { ...prevOverride, modelId: action.modelId },
        },
      };
    }

    case 'MISSION_SET_REASONING': {
      const m = state.missions[action.missionId];
      if (!m) return state;
      const prevOverride = state.missionSettingOverrides[action.missionId] ?? {};
      return {
        ...state,
        missions: {
          ...state.missions,
          [action.missionId]: { ...m, reasoningEffort: action.reasoning },
        },
        missionSettingOverrides: {
          ...state.missionSettingOverrides,
          [action.missionId]: { ...prevOverride, reasoningEffort: action.reasoning },
        },
      };
    }

    case 'SET_COMPACTION_MODEL_GLOBAL': {
      const value = saveCompactionModel(action.compactionModel);
      return { ...state, compactionModel: value };
    }

    case 'SET_COMPACTION_TOKEN_LIMIT_GLOBAL': {
      const limit = normalizeTokenLimit(action.limit);
      saveCompactionTokenLimit(limit);
      return { ...state, compactionTokenLimit: limit };
    }

    case 'SET_COMPACTION_TOKEN_LIMIT_FOR_MODEL': {
      const limit = normalizeTokenLimit(action.limit);
      const next = { ...state.compactionTokenLimitPerModel };
      if (limit === undefined) delete next[action.modelId];
      else next[action.modelId] = limit;
      saveCompactionTokenLimitPerModel(next);
      return { ...state, compactionTokenLimitPerModel: next };
    }

    case 'SET_LIVE_ENTER_BEHAVIOR': {
      const behavior = saveLiveEnterBehavior(action.behavior);
      return { ...state, liveEnterBehavior: behavior };
    }

    default:
      return state;
  }
}

function loadPersistedBrowsers(value: unknown): Record<string, BrowserState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, browser]) => [key, sanitizePersistedBrowser(key, browser)] as const)
    .filter((entry): entry is readonly [string, BrowserState] => Boolean(entry[1]));
  return Object.fromEntries(entries);
}

function loadPersistedBrowserOpenKeys(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  // Preserve both true (open) and false (explicitly hidden) so the "hidden"
  // decision survives a restart; a dropped `false` would let later updates
  // re-open a pane the user deliberately hid.
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, boolean] =>
      typeof entry[0] === 'string' && entry[0].length > 0 && typeof entry[1] === 'boolean',
  );
  return Object.fromEntries(entries);
}

function sanitizePersistedBrowser(key: string, value: unknown): BrowserState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const browser = value as Partial<BrowserState>;
  if (typeof browser.sessionId !== 'string' || !browser.sessionId) return undefined;
  if (typeof browser.url !== 'string' || !browser.url) return undefined;
  const viewport = sanitizeBrowserViewport(browser.viewport);
  if (!viewport) return undefined;
  return {
    sessionId: browser.sessionId,
    missionId: typeof browser.missionId === 'string' && browser.missionId ? browser.missionId : key,
    url: browser.url,
    title: typeof browser.title === 'string' ? browser.title : undefined,
    viewport,
    viewportMode: sanitizeBrowserViewportMode(browser.viewportMode),
    scroll: sanitizeBrowserScroll(browser.scroll),
    refs: [],
  };
}

function sanitizeBrowserViewport(value: unknown): BrowserState['viewport'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const viewport = value as Partial<BrowserState['viewport']>;
  const width = finitePositiveNumber(viewport.width);
  const height = finitePositiveNumber(viewport.height);
  const deviceScaleFactor = finitePositiveNumber(viewport.deviceScaleFactor);
  if (!width || !height || !deviceScaleFactor) return undefined;
  return { width, height, deviceScaleFactor };
}

function sanitizeBrowserViewportMode(value: unknown): BrowserViewportMode {
  return BROWSER_VIEWPORT_MODES.has(value as BrowserViewportMode)
    ? (value as BrowserViewportMode)
    : 'fit';
}

function sanitizeBrowserScroll(value: unknown): BrowserState['scroll'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { x: 0, y: 0 };
  const scroll = value as Partial<BrowserState['scroll']>;
  return { x: finiteNumber(scroll.x) ?? 0, y: finiteNumber(scroll.y) ?? 0 };
}

function persistBrowsers(browsers: Record<string, BrowserState>): Record<string, BrowserState> {
  return Object.fromEntries(
    Object.entries(browsers).map(([key, browser]) => [
      key,
      {
        ...browser,
        refs: [],
        agentCursor: undefined,
        screenshotPath: undefined,
        screenshotUrl: undefined,
      },
    ]),
  );
}

function finitePositiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number && number > 0 ? number : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/* ── Bridge event adapter ── */
function adaptEvent(ev: ServerEvent): Action | null {
  switch (ev.type) {
    case 'connection':
      return {
        type: 'SET_CONNECTION',
        status: ev.status === 'connected' ? 'connected' : 'error',
        message: ev.message,
      };
    case 'mission.created':
      return { type: 'MISSION_CREATED', clientRef: ev.clientRef, mission: ev.mission };
    case 'mission.updated':
      return { type: 'MISSION_UPDATED', mission: ev.mission };
    case 'mission.features':
      return { type: 'MISSION_FEATURES', missionId: ev.missionId, features: ev.features };
    case 'mission.progress':
      return { type: 'MISSION_PROGRESS', missionId: ev.missionId, entries: ev.entries };
    case 'mission.worker':
      return {
        type: 'MISSION_WORKER',
        missionId: ev.missionId,
        event: ev.event,
        workerSessionId: ev.workerSessionId,
        label: ev.label,
        prompt: ev.prompt,
        modelId: ev.modelId,
        reasoningEffort: ev.reasoningEffort,
        toolUseId: ev.toolUseId,
      };
    case 'agent.updated':
      return {
        type: 'AGENT_UPDATED',
        missionId: ev.missionId,
        agentSessionId: ev.agentSessionId,
        role: ev.role,
        status: ev.status,
      };
    case 'mission.tokens':
      return {
        type: 'MISSION_TOKENS',
        missionId: ev.missionId,
        tokensIn: ev.tokensIn,
        tokensOut: ev.tokensOut,
        contextTokens: ev.contextTokens,
        maxContextTokens: ev.maxContextTokens,
      };
    case 'mission.transcript':
      return { type: 'MISSION_TRANSCRIPT', event: ev.event };
    case 'mission.permission':
      return { type: 'MISSION_PERMISSION', request: ev.request };
    case 'mission.question':
      return { type: 'MISSION_QUESTION', question: ev.question };
    case 'mission.error':
      return { type: 'MISSION_ERROR', missionId: ev.missionId, message: ev.message };
    case 'error':
      // A failed worker open (capacity, load failure) carries the agent session
      // id; settle its loading flag so the card stops showing "Loading …
      // activity" forever. The mission.error companion event surfaces the toast.
      return ev.sessionId
        ? { type: 'AGENT_HISTORY_LOADING', agentSessionId: ev.sessionId, loading: false }
        : null;
    case 'mission.list':
      return { type: 'MISSION_LIST', missions: ev.missions };
    case 'mission.history':
      return {
        type: 'MISSION_HISTORY',
        missionId: ev.missionId,
        progress: ev.progress,
        transcripts: ev.transcripts,
        workers: ev.workers,
        mode: ev.mode,
        olderCursor: ev.olderCursor,
        loadedCount: ev.loadedCount,
        hasMore: ev.hasMore,
      };
    case 'mission.history.error':
      return { type: 'MISSION_HISTORY_FAILED', missionId: ev.missionId, message: ev.message };
    case 'models.list':
      return { type: 'MODELS_LIST', models: ev.models };
    case 'context.updated':
      return { type: 'CONTEXT_UPDATED', sessionId: ev.sessionId, stats: ev.stats };
    case 'catalog.updated':
      if (ev.catalog === 'skills') {
        const skills = (ev.items as SkillInfo[]).filter(
          (s) => s && typeof s.name === 'string' && s.name.length > 0,
        );
        return { type: 'SKILLS_LIST', skills, sessionId: ev.sessionId ?? null };
      }
      return null;
    case 'settings.defaults':
      return { type: 'FACTORY_DEFAULTS', defaults: ev.defaults };
    case 'browser.updated':
      return { type: 'BROWSER_UPDATED', browser: ev.state };
    case 'browser.closed':
      return { type: 'BROWSER_CLOSED', missionId: ev.missionId };
    case 'browser.error':
      return { type: 'BROWSER_ERROR', missionId: ev.missionId, message: ev.message };
    default:
      return null;
  }
}

const StoreContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(
  null,
);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, syncBrowserOpen);

  useEffect(() => {
    savePersistedUiState(state);
  }, [
    state.activeMissionId,
    state.browserOpenKeys,
    state.browsers,
    state.missionMode,
    state.rightPanelOpen,
    state.selectedAgentSessionId,
    state.selectedFeatureId,
    state.sidebarCollapsed,
    state.specMode,
  ]);

  // Keep the sidecar's compaction-limit snapshot in sync so live sessions,
  // resumes, and model changes all follow these limits. The bridge queues
  // commands until the socket opens, so the mount-time push is safe, and the
  // FACTORY_DEFAULTS seed re-fires this effect with the merged values. An
  // Undefined/empty values only mean "cleared" after the user stored them; on
  // a cold mount those fields are omitted so the sidecar keeps following
  // CLI-file defaults instead of treating first launch as an explicit clear.
  useEffect(() => {
    updateCompactionSettings(compactionSettingsSnapshot(state));
  }, [state.compactionTokenLimit, state.compactionTokenLimitPerModel]);

  useEffect(() => {
    const unsub = bridge.subscribe((ev) => {
      console.log('[bridge]', ev.type, sanitizeForLog(ev));
      const action = adaptEvent(ev);
      if (action) dispatch(action);
    });
    return () => {
      unsub();
    };
  }, []);

  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used within StoreProvider');
  return context;
}
