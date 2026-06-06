import { createContext, useContext, useReducer, ReactNode, useEffect } from 'react';
import { bridge } from '../lib/bridge';
import { subscribeWorker } from '../lib/commands';
import type {
  FactoryDefaultSettings,
  ServerEvent,
  MissionSummary,
  TranscriptEvent,
  ProgressEntry,
  PermissionRequest,
  MissionQuestion,
  ModelInfo,
  SkillInfo,
  ReasoningEffort,
  ContextStatsSnapshot,
  SessionKind,
  BrowserState,
} from '../types/bridge';

export type AgentKind = 'orchestrator' | 'worker' | 'validator';

export interface WorkerInfo {
  sessionId: string;
  status: 'running' | 'completed';
  startedAt: number;
  label?: string;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  skills: string[];
  files: string[];
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
  uiFontSize: number;
  codeFontSize: number;
  translucentSidebar: boolean;
  diffStyle: 'color' | 'symbol';
  contrast: number;
}

interface AppState {
  // Connection
  connection: 'idle' | 'connecting' | 'connected' | 'error';
  connectionError?: string;

  // Missions domain
  missions: Record<string, MissionSummary>;
  missionOrder: string[];
  activeMissionId: string | null;
  transcripts: Record<string, TranscriptEvent[]>;
  progress: Record<string, ProgressEntry[]>;
  workers: Record<string, WorkerInfo[]>;   // subagents spawned per mission
  historyLoaded: Record<string, boolean>;
  pendingPermission: PermissionRequest | null;
  pendingQuestion: MissionQuestion | null;
  contextStats: Record<string, ContextStatsSnapshot>;
  specPlans: Record<string, string>;   // latest ExitSpecMode plan per session

  // UI flags
  rightPanelOpen: boolean;
  sidebarCollapsed: boolean;
  specMode: boolean;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  theme: ThemeConfig;
  missionMode: boolean;
  draftChat: { cwd: string } | null;
  browserOpen: boolean;
  browsers: Record<string, BrowserState>;
  browserErrors: Record<string, string>;
  browserGlobalError?: string;
  designMode: boolean;

  // Mission Control view
  selectedFeatureId: string | null;
  selectedAgentSessionId: string | null; // 'orchestrator' or worker session id

  // Models / per-agent config
  models: ModelInfo[];
  agentConfig: AgentConfig;

  // Global compaction model applied to every session. 'current-model' = use
  // each session's active model; otherwise a specific model id.
  compactionModel: string;

  // Per-mission model/reasoning the user picked in the selector. These are
  // authoritative: a stale server summary (e.g. an in-flight resume) must not
  // revert the user's choice back to the session default.
  missionSettingOverrides: Record<string, { modelId?: string; reasoningEffort?: ReasoningEffort; compactionModel?: string }>;

  // Skills catalog (for / invocation)
  skills: SkillInfo[];

  // Attachments for the first message of a not-yet-created mission, keyed by clientRef.
  pendingCompose: Record<string, { text: string; skills: string[]; files: string[] }>;

  promptQueue: Record<string, QueuedPrompt[]>;
}

type Action =
  // Connection
  | { type: 'SET_CONNECTION'; status: 'idle' | 'connecting' | 'connected' | 'error'; message?: string }

  // Mission lifecycle
  | { type: 'MISSION_CREATED'; clientRef: string; mission: MissionSummary }
  | { type: 'SET_PENDING_COMPOSE'; clientRef: string; text: string; skills: string[]; files: string[] }
  | { type: 'MISSION_UPDATED'; mission: MissionSummary }
  | { type: 'MISSION_FEATURES'; missionId: string; features: MissionSummary['features'] }
  | { type: 'MISSION_PROGRESS'; missionId: string; entries: ProgressEntry[] }
  | { type: 'MISSION_WORKER'; missionId: string; event: 'started' | 'completed'; workerSessionId: string; label?: string }
  | { type: 'MISSION_TOKENS'; missionId: string; tokensIn: number; tokensOut: number; contextTokens: number; maxContextTokens?: number }
  | { type: 'CONTEXT_UPDATED'; sessionId: string; stats: ContextStatsSnapshot }
  | { type: 'MISSION_TRANSCRIPT'; event: TranscriptEvent }
  | { type: 'MISSION_PERMISSION'; request: PermissionRequest }
  | { type: 'MISSION_QUESTION'; question: MissionQuestion }
  | { type: 'MISSION_ERROR'; missionId?: string; message: string }
  | { type: 'MISSION_LIST'; missions: MissionSummary[] }
  | { type: 'MISSION_HISTORY'; missionId: string; progress: ProgressEntry[]; transcripts: TranscriptEvent[] }
  | { type: 'CLEAR_PERMISSION' }
  | { type: 'CLEAR_QUESTION' }

  // UI
  | { type: 'SET_ACTIVE_MISSION'; id: string | null }
  | { type: 'SET_RIGHT_PANEL'; open: boolean }
  | { type: 'TOGGLE_COMMAND_PALETTE' }
  | { type: 'CLOSE_COMMAND_PALETTE' }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'TOGGLE_SPEC_MODE' }
  | { type: 'MISSION_SET_KIND'; missionId: string; kind: SessionKind }
  | { type: 'TOGGLE_SETTINGS' }
  | { type: 'TOGGLE_MISSION_MODE' }
  | { type: 'START_CHAT'; cwd: string }
  | { type: 'TOGGLE_BROWSER' }
  | { type: 'SET_BROWSER_OPEN'; open: boolean }
  | { type: 'BROWSER_UPDATED'; browser: BrowserState }
  | { type: 'BROWSER_ERROR'; missionId?: string; message: string }
  | { type: 'TOGGLE_DESIGN_MODE' }
  | { type: 'SET_DESIGN_MODE'; open: boolean }
  | { type: 'SET_THEME'; theme: Partial<ThemeConfig> }
  | { type: 'SELECT_FEATURE'; id: string | null }
  | { type: 'SELECT_AGENT'; id: string | null }

  // Models / per-agent config
  | { type: 'MODELS_LIST'; models: ModelInfo[] }
  | { type: 'SKILLS_LIST'; skills: SkillInfo[] }
  | { type: 'FACTORY_DEFAULTS'; defaults: FactoryDefaultSettings }
  | { type: 'SET_AGENT_MODEL'; agent: AgentKind; modelId?: string }
  | { type: 'SET_AGENT_REASONING'; agent: AgentKind; reasoning: ReasoningEffort }
  | { type: 'MISSION_SET_MODEL'; missionId: string; modelId?: string }
  | { type: 'MISSION_SET_REASONING'; missionId: string; reasoning: ReasoningEffort }
  | { type: 'MISSION_SET_COMPACTION_MODEL'; missionId: string; compactionModel: string }
  | { type: 'SET_COMPACTION_MODEL_GLOBAL'; compactionModel: string }

  | { type: 'QUEUE_PROMPT'; missionId: string; prompt: QueuedPrompt }
  | { type: 'UPDATE_QUEUED_PROMPT'; missionId: string; id: string; text: string }
  | { type: 'REMOVE_QUEUED_PROMPT'; missionId: string; id: string }
  | { type: 'REORDER_QUEUE'; missionId: string; from: number; to: number };

const defaultTheme: ThemeConfig = {
  mode: 'dark',
  accent: '#ee6018',
  bg: '#0a0a0a',
  fg: '#ededed',
  surface: '#111111',
  border: '#1f1f1f',
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

function loadTheme(): ThemeConfig {
  try {
    const saved = localStorage.getItem('droid-theme');
    if (saved) return { ...defaultTheme, ...JSON.parse(saved) };
  } catch { /* ignore */ }
  return defaultTheme;
}

function loadAgentConfig(): AgentConfig {
  try {
    OLD_AGENT_CONFIG_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    const raw = localStorage.getItem(AGENT_CONFIG_STORAGE_KEY);
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

function readAgentConfig(value: Partial<AgentModelConfig> | undefined, fallback: AgentModelConfig): AgentModelConfig {
  return {
    modelId: typeof value?.modelId === 'string' && value.modelId ? value.modelId : fallback.modelId,
    reasoning: isReasoningEffort(value?.reasoning) ? value.reasoning : fallback.reasoning,
  };
}

function saveAgentConfig(config: AgentConfig): AgentConfig {
  try {
    localStorage.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch { /* ignore */ }
  return config;
}

// Global compaction model: 'current-model' means each session compacts with
// whatever model it is currently using; otherwise a specific model id is used
// for compaction across every session.
const COMPACTION_MODEL_STORAGE_KEY = 'droid-compaction-model';

function loadCompactionModel(): string {
  try {
    return localStorage.getItem(COMPACTION_MODEL_STORAGE_KEY) || 'current-model';
  } catch {
    return 'current-model';
  }
}

function saveCompactionModel(value: string): string {
  try {
    localStorage.setItem(COMPACTION_MODEL_STORAGE_KEY, value);
  } catch { /* ignore */ }
  return value;
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
  if (!supported?.length && model.defaultReasoningEffort && config.reasoning !== model.defaultReasoningEffort) {
    return { modelId: config.modelId, reasoning: model.defaultReasoningEffort };
  }
  return config;
}

function applyMissionOverride(
  summary: MissionSummary,
  override?: { modelId?: string; reasoningEffort?: ReasoningEffort; compactionModel?: string },
): MissionSummary {
  if (!override) return summary;
  const next = { ...summary };
  if ('modelId' in override) next.modelId = override.modelId;
  if (override.reasoningEffort !== undefined) next.reasoningEffort = override.reasoningEffort;
  if (override.compactionModel !== undefined) next.compactionModel = override.compactionModel;
  return next;
}

const initialState: AppState = {
  connection: 'idle',
  missions: {},
  missionOrder: [],
  activeMissionId: null,
  transcripts: {},
  progress: {},
  workers: {},
  historyLoaded: {},
  pendingPermission: null,
  pendingQuestion: null,
  contextStats: {},
  specPlans: {},
  rightPanelOpen: false,
  sidebarCollapsed: false,
  specMode: false,
  settingsOpen: false,
  commandPaletteOpen: false,
  theme: loadTheme(),
  missionMode: false,
  draftChat: null,
  browserOpen: false,
  browsers: {},
  browserErrors: {},
  browserGlobalError: undefined,
  designMode: false,
  selectedFeatureId: null,
  selectedAgentSessionId: null,
  models: [],
  compactionModel: loadCompactionModel(),
  missionSettingOverrides: {},
  skills: [],
  agentConfig: loadAgentConfig(),
  pendingCompose: {},
  promptQueue: {},
};

function progressKey(entry: ProgressEntry): string {
  return `${entry.timestamp}|${entry.type}|${entry.featureId ?? ''}|${entry.workerSessionId ?? ''}|${entry.title ?? ''}`;
}

function reducer(state: AppState, action: Action): AppState {
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
        ? Object.fromEntries(Object.entries(state.pendingCompose).filter(([k]) => k !== action.clientRef))
        : state.pendingCompose;

      const next = {
        ...state,
        missions: { ...state.missions, [action.mission.id]: applyMissionOverride(action.mission, state.missionSettingOverrides[action.mission.id]) },
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
      const m = applyMissionOverride(action.mission, state.missionSettingOverrides[action.mission.id]);
      return {
        ...state,
        missions: { ...state.missions, [m.id]: m },
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
          status: action.event === 'completed' ? 'completed' : next[idx].status,
          label: action.label ?? next[idx].label,
        };
      } else {
        next = [...prev, { sessionId: action.workerSessionId, status: action.event === 'completed' ? 'completed' : 'running', startedAt: Date.now(), label: action.label }];
      }
      return { ...state, workers: { ...state.workers, [mid]: next } };
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

      return {
        ...state,
        transcripts: { ...state.transcripts, [mid]: [...prev, ev] },
      };
    }

    case 'MISSION_PERMISSION': {
      const r = action.request;
      const specPlans =
        r.kind === 'spec' && r.plan
          ? { ...state.specPlans, [r.missionId]: r.plan }
          : state.specPlans;
      return { ...state, pendingPermission: r, specPlans };
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
      const map: Record<string, MissionSummary> = {};
      const order: string[] = [];
      for (const m of action.missions) {
        map[m.id] = applyMissionOverride(m, state.missionSettingOverrides[m.id]);
        order.push(m.id);
      }
      return {
        ...state,
        missions: map,
        missionOrder: order,
        activeMissionId: state.activeMissionId && map[state.activeMissionId] ? state.activeMissionId : order[0] ?? null,
      };
    }

    case 'MISSION_HISTORY': {
      // Don't let an empty history snapshot wipe a locally-seeded transcript
      // (e.g. a brand-new mission whose session isn't persisted to disk yet).
      const existing = state.transcripts[action.missionId] ?? [];
      const transcripts = action.transcripts.length === 0 && existing.length > 0
        ? state.transcripts
        : { ...state.transcripts, [action.missionId]: action.transcripts };
      return {
        ...state,
        progress: { ...state.progress, [action.missionId]: action.progress },
        transcripts,
        historyLoaded: { ...state.historyLoaded, [action.missionId]: true },
      };
    }

    case 'CLEAR_PERMISSION':
      return { ...state, pendingPermission: null };

    case 'CLEAR_QUESTION':
      return { ...state, pendingQuestion: null };

    case 'SET_ACTIVE_MISSION':
      return { ...state, activeMissionId: action.id, draftChat: null, selectedAgentSessionId: null };

    case 'SET_RIGHT_PANEL':
      return { ...state, rightPanelOpen: action.open };

    case 'TOGGLE_COMMAND_PALETTE':
      return { ...state, commandPaletteOpen: !state.commandPaletteOpen };

    case 'CLOSE_COMMAND_PALETTE':
      return { ...state, commandPaletteOpen: false };

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
      return { ...state, draftChat: { cwd: action.cwd }, activeMissionId: null, missionMode: false };

    case 'TOGGLE_BROWSER':
      return { ...state, browserOpen: !state.browserOpen };

    case 'SET_BROWSER_OPEN':
      return { ...state, browserOpen: action.open };

    case 'BROWSER_UPDATED':
      if (!action.browser.missionId) return state;
      return {
        ...state,
        browsers: { ...state.browsers, [action.browser.missionId]: action.browser },
        browserErrors: Object.fromEntries(Object.entries(state.browserErrors).filter(([id]) => id !== action.browser.missionId)),
        browserOpen: state.activeMissionId === action.browser.missionId ? true : state.browserOpen,
      };

    case 'BROWSER_ERROR':
      return action.missionId
        ? {
            ...state,
            browserErrors: { ...state.browserErrors, [action.missionId]: action.message },
            browserOpen: state.activeMissionId === action.missionId ? true : state.browserOpen,
          }
        : { ...state, browserGlobalError: action.message };

    case 'TOGGLE_DESIGN_MODE':
      return { ...state, designMode: !state.designMode };

    case 'SET_DESIGN_MODE':
      return { ...state, designMode: action.open };

    case 'SET_THEME': {
      const next = { ...state.theme, ...action.theme };
      try { localStorage.setItem('droid-theme', JSON.stringify(next)); } catch { /* ignore */ }
      return { ...state, theme: next };
    }

    case 'SELECT_FEATURE':
      return { ...state, selectedFeatureId: action.id };

    case 'SELECT_AGENT':
      return { ...state, selectedAgentSessionId: action.id };

    case 'MODELS_LIST':
      return { ...state, models: action.models, agentConfig: saveAgentConfig(sanitizeAgentConfig(state.agentConfig, action.models)) };

    case 'SKILLS_LIST':
      return { ...state, skills: action.skills };

    case 'FACTORY_DEFAULTS': {
      const next = sanitizeAgentConfig({
        orchestrator: {
          modelId: state.agentConfig.orchestrator.modelId ?? action.defaults.modelId,
          reasoning: state.agentConfig.orchestrator.modelId ? state.agentConfig.orchestrator.reasoning : action.defaults.reasoningEffort ?? state.agentConfig.orchestrator.reasoning,
        },
        worker: {
          modelId: state.agentConfig.worker.modelId ?? action.defaults.workerModelId,
          reasoning: state.agentConfig.worker.modelId ? state.agentConfig.worker.reasoning : action.defaults.workerReasoningEffort ?? state.agentConfig.worker.reasoning,
        },
        validator: {
          modelId: state.agentConfig.validator.modelId ?? action.defaults.validatorModelId,
          reasoning: state.agentConfig.validator.modelId ? state.agentConfig.validator.reasoning : action.defaults.validatorReasoningEffort ?? state.agentConfig.validator.reasoning,
        },
      }, state.models);
      return { ...state, agentConfig: saveAgentConfig(next) };
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
        missions: { ...state.missions, [action.missionId]: { ...m, reasoningEffort: action.reasoning } },
        missionSettingOverrides: {
          ...state.missionSettingOverrides,
          [action.missionId]: { ...prevOverride, reasoningEffort: action.reasoning },
        },
      };
    }

    case 'MISSION_SET_COMPACTION_MODEL': {
      const m = state.missions[action.missionId];
      if (!m) return state;
      const prevOverride = state.missionSettingOverrides[action.missionId] ?? {};
      return {
        ...state,
        missions: { ...state.missions, [action.missionId]: { ...m, compactionModel: action.compactionModel } },
        missionSettingOverrides: {
          ...state.missionSettingOverrides,
          [action.missionId]: { ...prevOverride, compactionModel: action.compactionModel },
        },
      };
    }

    case 'SET_COMPACTION_MODEL_GLOBAL': {
      const value = saveCompactionModel(action.compactionModel);
      const perSession = value === 'current-model' ? undefined : value;
      const missions = Object.fromEntries(
        Object.entries(state.missions).map(([id, m]) => [id, { ...m, compactionModel: perSession }]),
      );
      return { ...state, compactionModel: value, missions };
    }

    case 'QUEUE_PROMPT': {
      const prev = state.promptQueue[action.missionId] ?? [];
      return {
        ...state,
        promptQueue: { ...state.promptQueue, [action.missionId]: [...prev, action.prompt] },
      };
    }

    case 'UPDATE_QUEUED_PROMPT': {
      const prev = state.promptQueue[action.missionId] ?? [];
      return {
        ...state,
        promptQueue: {
          ...state.promptQueue,
          [action.missionId]: prev.map((p) => (p.id === action.id ? { ...p, text: action.text } : p)),
        },
      };
    }

    case 'REMOVE_QUEUED_PROMPT': {
      const prev = state.promptQueue[action.missionId] ?? [];
      return {
        ...state,
        promptQueue: { ...state.promptQueue, [action.missionId]: prev.filter((p) => p.id !== action.id) },
      };
    }

    case 'REORDER_QUEUE': {
      const prev = state.promptQueue[action.missionId] ?? [];
      if (action.from === action.to || action.from < 0 || action.to < 0 || action.from >= prev.length || action.to >= prev.length) {
        return state;
      }
      const next = [...prev];
      const [moved] = next.splice(action.from, 1);
      next.splice(action.to, 0, moved);
      return { ...state, promptQueue: { ...state.promptQueue, [action.missionId]: next } };
    }

    default:
      return state;
  }
}

/* ── Bridge event adapter ── */
function adaptEvent(ev: ServerEvent): Action | null {
  switch (ev.type) {
    case 'connection':
      return { type: 'SET_CONNECTION', status: ev.status === 'connected' ? 'connected' : 'error', message: ev.message };
    case 'mission.created':
      return { type: 'MISSION_CREATED', clientRef: ev.clientRef, mission: ev.mission };
    case 'mission.updated':
      return { type: 'MISSION_UPDATED', mission: ev.mission };
    case 'mission.features':
      return { type: 'MISSION_FEATURES', missionId: ev.missionId, features: ev.features };
    case 'mission.progress':
      return { type: 'MISSION_PROGRESS', missionId: ev.missionId, entries: ev.entries };
    case 'mission.worker':
      return { type: 'MISSION_WORKER', missionId: ev.missionId, event: ev.event, workerSessionId: ev.workerSessionId, label: ev.label };
    case 'mission.tokens':
      return { type: 'MISSION_TOKENS', missionId: ev.missionId, tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, contextTokens: ev.contextTokens, maxContextTokens: ev.maxContextTokens };
    case 'mission.transcript':
      return { type: 'MISSION_TRANSCRIPT', event: ev.event };
    case 'mission.permission':
      return { type: 'MISSION_PERMISSION', request: ev.request };
    case 'mission.question':
      return { type: 'MISSION_QUESTION', question: ev.question };
    case 'mission.error':
      return { type: 'MISSION_ERROR', missionId: ev.missionId, message: ev.message };
    case 'mission.list':
      return { type: 'MISSION_LIST', missions: ev.missions };
    case 'mission.history':
      return { type: 'MISSION_HISTORY', missionId: ev.missionId, progress: ev.progress, transcripts: ev.transcripts };
    case 'models.list':
      return { type: 'MODELS_LIST', models: ev.models };
    case 'context.updated':
      return { type: 'CONTEXT_UPDATED', sessionId: ev.sessionId, stats: ev.stats };
    case 'catalog.updated':
      if (ev.catalog === 'skills') {
        const skills = (ev.items as SkillInfo[]).filter(
          (s) => s && typeof s.name === 'string' && s.name.length > 0
        );
        return { type: 'SKILLS_LIST', skills };
      }
      return null;
    case 'settings.defaults':
      return { type: 'FACTORY_DEFAULTS', defaults: ev.defaults };
    case 'browser.updated':
      return { type: 'BROWSER_UPDATED', browser: ev.state };
    case 'browser.error':
      return { type: 'BROWSER_ERROR', missionId: ev.missionId, message: ev.message };
    default:
      return null;
  }
}

const StoreContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const unsub = bridge.subscribe((ev) => {
      console.log('[bridge]', ev.type, ev);
      // Stream a subagent's transcript as soon as it spawns so it's viewable.
      if (ev.type === 'mission.worker' && ev.event === 'started') {
        subscribeWorker(ev.missionId, ev.workerSessionId);
      }
      const action = adaptEvent(ev);
      if (action) dispatch(action);
    });
    return () => { unsub(); };
  }, []);

  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used within StoreProvider');
  return context;
}
