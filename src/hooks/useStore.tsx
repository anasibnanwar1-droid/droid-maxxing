import type { ReactNode } from 'react';
import { createContext, useContext, useMemo, useReducer, useState, useEffect } from 'react';
import { bridge } from '../lib/bridge';
import { normalizeAppIconMode, type AppIconMode } from '../lib/appIcon';
import { updateCompactionSettings } from '../lib/commands';
import { migrateLegacyLightPreset } from '../lib/theme';
import {
  clearDesignMode,
  setDesignMode,
  toggleDesignMode,
  type DesignModes,
} from './designModeState';
import type {
  Autonomy,
  FactoryDefaultSettings,
  ServerEvent,
  SessionSummary,
  TranscriptEvent,
  ProgressEntry,
  PermissionRequest,
  SessionQuestion,
  ModelInfo,
  ChildSessionSummary,
  SkillInfo,
  ReasoningEffort,
  ContextStatsSnapshot,
  BrowserState,
  BrowserViewportMode,
  DesignReference,
} from '../types/bridge';
import { addWorkspaceCwd } from '../lib/workspaces';
import { loadDefaultAutonomy, saveDefaultAutonomy } from '../lib/autonomy';
import {
  applyFactoryCompactionDefaults,
  compactionSettingsSnapshot,
  loadCompactionTokenLimit,
  loadCompactionTokenLimitPerModel,
  normalizeTokenLimit,
  saveCompactionTokenLimit,
  saveCompactionTokenLimitPerModel,
} from '../lib/compactionSettings';
import { sanitizeForLog } from '../lib/sensitiveLogRedaction';
import { composePrompt } from '../lib/composePrompt';
import {
  addSessionNote,
  loadSessionNotes,
  markSessionNoteUsed,
  removeSessionNote,
  saveSessionNotes,
  type SessionNotesMap,
} from '../lib/sessionNotes';
import { createSnapshotScheduler, loadSessionSnapshot } from '../lib/sessionSnapshot';
import { toast } from '../lib/toast';
import { DIFF_SCOPES, type DiffScope } from '../types/vcs';
import {
  activateUtilityTab,
  closeUtilityTab,
  openUtilityTool,
  persistUtilityPanels,
  removeUtilityTool,
  sanitizeUtilityPanels,
  setUtilityPanelOpen,
  updateUtilityTab,
  utilityPanelForSession,
  type UtilityPanelState,
  type UtilityTool,
} from '../lib/utilityPanel';
import type { ImagePasteQuality } from '../lib/images';

export type AgentKind = 'primary' | 'worker' | 'validator';
export type ChildSettingsReadiness = 'opening' | 'ready' | 'failed';
export type LiveEnterBehavior = 'queue' | 'interrupt';
export type DiffViewMode = 'unified' | 'split';
export type { ImagePasteQuality } from '../lib/images';

export type ChildSessionInfo = ChildSessionSummary;

export interface ChildSelection {
  parentAppSessionId: string;
  childSessionId: string;
}

export type ChildAccess =
  | { state: 'opening'; requestId: string }
  | { state: 'ready'; requestId: string; runtimeGeneration: number }
  | { state: 'history'; requestId: string }
  | { state: 'failed'; requestId: string | null }
  | { state: 'closed'; requestId: null };

export interface ChildRuntimeState {
  available: boolean;
  runtimeGeneration: number;
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

export type DiffStyle = 'soft' | 'focused';

export interface ThemeConfig {
  mode: 'dark' | 'light' | 'system';
  appIconMode: AppIconMode;
  accent: string;
  bg: string;
  fg: string;
  surface: string;
  border: string;
  uiFont: string;
  uiFontSize: number;
  codeFontSize: number;
  translucentSidebar: boolean;
  diffStyle: DiffStyle;
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

  // Sessions domain
  sessions: Record<string, SessionSummary>;
  sessionOrder: string[];
  // Ids vouched for by the last authoritative listing: the boot snapshot
  // before the first SESSION_LIST, then the sessions of the most recent
  // SESSION_LIST. A SESSION_LIST prunes confirmed rows it no longer reports,
  // so a session deleted outside the app disappears on the next list push.
  // Rows added locally this run (SESSION_CREATED/SESSION_UPDATED) are not in
  // the set and survive lists that do not mention them yet.
  listConfirmedSessionIds: string[] | null;
  activeAppSessionId: string | null;
  // appSessionId -> last time the user viewed it. A session reads as "unread" when
  // its updatedAt (latest model activity) is newer than this. Internal only:
  // surfaced as a bold row in the sidebar, never shown as a timestamp.
  sessionLastSeen: Record<string, number>;
  transcripts: Record<string, TranscriptEvent[]>;
  progress: Record<string, ProgressEntry[]>;
  childSessions: Record<string, Record<string, ChildSessionInfo>>;
  historyLoaded: Record<string, boolean>;
  // Cursor for the next older page of primary-session scrollback;
  // undefined/absent once the oldest compaction segment has been loaded.
  historyCursor: Record<string, string | undefined>;
  // Whether an older-history page is currently in flight (prevents duplicate
  // prefetches while the user keeps scrolling up).
  historyLoadingOlder: Record<string, boolean>;
  // Explicit transcript-restore state per session: whether the initial replay
  // is loading, partially loaded (older pages remain), fully loaded, or failed.
  // Lets the chat show an honest restoring/partial/retry surface instead of a
  // blank or silently truncated transcript (#29).
  sessionRestore: Record<string, SessionRestore>;
  childAccess: Record<string, Record<string, ChildAccess>>;
  childRuntime: Record<string, Record<string, ChildRuntimeState>>;
  pendingPermission: PermissionRequest | null;
  pendingQuestion: SessionQuestion | null;
  contextStats: {
    primary: Record<string, ContextStatsSnapshot>;
    child: Record<string, Record<string, ContextStatsSnapshot>>;
  };
  specPlans: Record<string, string>; // latest ExitSpecMode plan per session
  // Persisted spec per session (file path + rendered content). Survives exiting
  // spec mode so the inline card, mermaid, and the wiki reader stay available.
  sessionSpecs: Record<string, { path?: string; title: string; content: string }>;
  // Which session's spec is open in the full wiki reader (null = closed).
  specWikiAppSessionId: string | null;
  // Held locally until the current turn finishes, then delivered one at a time.
  promptQueue: Record<string, QueuedPrompt[]>;
  // Scratch notes parked from the Context panel, per session. Persisted in
  // localStorage so reminders survive app restarts.
  sessionNotes: SessionNotesMap;

  // UI flags
  rightPanelOpen: boolean;
  utilityPanels: Record<string, UtilityPanelState>;
  // The Review diff tab: a wide right-side pane, opened from the Context panel's
  // changes button. Scope + view mode persist; open state is per-session — we
  // track the session it was opened for so switching chats doesn't carry it over.
  reviewOpenAppSessionId: string | null;
  reviewScope: DiffScope;
  // A file path the Review pane should jump to once its list loads, set when a
  // per-turn changes summary (or diff card) is clicked. Cleared after the jump.
  reviewFocusPath: string | null;
  // Generation counter for focus requests: every OPEN_REVIEW_AT bumps it so
  // the Review pane can tell a fresh click apart from a re-render of the
  // previous request (a repeated click must re-arm the scope-fallback dedupe).
  reviewFocusRequestId: number;
  diffView: DiffViewMode;
  sidebarCollapsed: boolean;
  specMode: boolean;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  theme: ThemeConfig;
  missionControlMode: boolean;
  draftChat: { cwd: string; branch?: string } | null;
  // Persisted app-wide default autonomy for new sessions. Owned by Settings;
  // factory-default reloads and draft/session changes never overwrite it.
  defaultAutonomy: Autonomy;
  // Autonomy override for the current unsent draft. Null means the draft
  // follows `defaultAutonomy`; reset whenever the draft lifecycle resets.
  draftAutonomy: Autonomy | null;
  // Live-session autonomy changes awaiting provider confirmation, keyed by
  // appSessionId. The UI keeps showing the confirmed value while pending.
  pendingAutonomy: Record<string, Autonomy>;
  // One-shot text seeded into the composer (welcome-screen suggestion cards,
  // saved-note clicks). A fresh id per seed lets re-clicking re-arm the effect.
  composerSeed: { text: string; id: number } | null;
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
  selectedChild: ChildSelection | null;

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
  // Bumped on every compaction-settings change (including clears that leave
  // the values structurally identical, e.g. undefined -> cleared undefined) so
  // the push effect always re-fires and the sidecar snapshot never goes stale.
  compactionSettingsRev: number;
  liveEnterBehavior: LiveEnterBehavior;
  // Fidelity tier for images pasted or dropped into the composer.
  imagePasteQuality: ImagePasteQuality;

  // Per-session model/reasoning the user picked in the selector. These are
  // authoritative: a stale server summary (e.g. an in-flight resume) must not
  // revert the user's choice back to the session default.
  sessionSettingOverrides: Record<string, { modelId?: string; reasoningEffort?: ReasoningEffort }>;

  // Skills catalog (for / invocation)
  skills: SkillInfo[];
  skillsProviderSessionId?: string | null;

  // Attachments for the first message of a not-yet-created session, keyed by clientRef.
  pendingCompose: Partial<Record<string, { text: string; skills: string[]; files: string[] }>>;
}

type Action =
  // Connection
  | {
      type: 'SET_CONNECTION';
      status: 'idle' | 'connecting' | 'connected' | 'error';
      message?: string;
    }

  // Session lifecycle
  | { type: 'SESSION_CREATED'; clientRef: string; session: SessionSummary }
  | {
      type: 'SET_PENDING_COMPOSE';
      clientRef: string;
      text: string;
      skills: string[];
      files: string[];
    }
  | { type: 'SESSION_UPDATED'; session: SessionSummary }
  | { type: 'SESSION_CLOSED'; appSessionId: string }
  | { type: 'SESSION_FEATURES'; appSessionId: string; features: SessionSummary['features'] }
  | { type: 'SESSION_PROGRESS'; appSessionId: string; entries: ProgressEntry[] }
  | {
      type: 'SESSION_CHILD';
      child: ChildSessionSummary;
      runtimeAvailable: boolean;
      runtimeGeneration: number;
    }
  | (
      | {
          type: 'CHILD_UPDATED';
          parentAppSessionId: string;
          childSessionId: string;
          requestId: string;
          access: 'ready';
          runtimeGeneration: number;
        }
      | {
          type: 'CHILD_UPDATED';
          parentAppSessionId: string;
          childSessionId: string;
          requestId: string;
          access: 'history';
        }
    )
  | {
      type: 'CHILD_ERROR';
      parentAppSessionId: string;
      childSessionId: string;
      requestId: string | null;
      operation: 'open' | 'send' | 'sendNow' | 'interrupt' | 'settings';
      message: string;
    }
  | {
      type: 'SESSION_TOKENS';
      appSessionId: string;
      tokensIn: number;
      tokensOut: number;
      contextTokens: number;
      maxContextTokens?: number;
    }
  | {
      type: 'CONTEXT_UPDATED';
      appSessionId: string;
      sourceSessionId: string;
      parentAppSessionId?: string;
      childSessionId?: string;
      stats: ContextStatsSnapshot;
    }
  | { type: 'SESSION_TRANSCRIPT'; event: TranscriptEvent }
  | { type: 'QUEUE_PROMPT'; appSessionId: string; prompt: QueuedPrompt }
  | { type: 'REMOVE_QUEUED_PROMPT'; appSessionId: string; id: string }
  | { type: 'REORDER_QUEUE'; appSessionId: string; from: number; to: number }
  | { type: 'SPEC_SET'; appSessionId: string; path?: string; title: string; content: string }
  | { type: 'SPEC_OPEN_WIKI'; appSessionId: string }
  | { type: 'SPEC_CLOSE_WIKI' }
  | { type: 'SESSION_PERMISSION'; request: PermissionRequest }
  | { type: 'SESSION_QUESTION'; question: SessionQuestion }
  | {
      type: 'SESSION_ERROR';
      appSessionId?: string;
      providerSessionId?: string;
      message: string;
    }
  | { type: 'SESSION_CREATE_FAILED'; clientRef: string; message: string }
  | { type: 'SESSION_LIST'; sessions: SessionSummary[] }
  | {
      type: 'SESSION_HISTORY';
      appSessionId: string;
      progress: ProgressEntry[];
      transcripts: TranscriptEvent[];
      childSessions?: ChildSessionSummary[];
      mode?: 'replace' | 'prepend';
      olderCursor?: string;
      loadedCount?: number;
      hasMore?: boolean;
    }
  | { type: 'SESSION_RESTORE_START'; appSessionId: string }
  | { type: 'SESSION_HISTORY_FAILED'; appSessionId: string; message: string }
  | { type: 'SESSION_HISTORY_LOADING_OLDER'; appSessionId: string }
  | { type: 'CLEAR_PERMISSION' }
  | { type: 'CLEAR_QUESTION' }

  // UI
  | { type: 'SET_ACTIVE_SESSION'; id: string | null }
  | { type: 'MARK_ALL_SESSIONS_READ'; seenAt: number }
  | { type: 'SET_RIGHT_PANEL'; open: boolean }
  | {
      type: 'OPEN_UTILITY_TOOL';
      tool: UtilityTool;
      tabId?: string;
      terminalId?: string;
      cwd?: string;
      filePath?: string;
    }
  | { type: 'CLOSE_UTILITY_TAB'; tabId: string; appSessionId?: string }
  | { type: 'ACTIVATE_UTILITY_TAB'; tabId: string }
  | {
      type: 'UPDATE_UTILITY_TAB';
      tabId: string;
      appSessionId?: string;
      terminalId?: string;
      cwd?: string;
      filePath?: string;
      label?: string;
    }
  | { type: 'SET_UTILITY_PANEL_OPEN'; open: boolean }
  | { type: 'SET_REVIEW_OPEN'; open: boolean }
  | { type: 'SET_REVIEW_SCOPE'; scope: DiffScope }
  | { type: 'OPEN_REVIEW_AT'; scope: DiffScope; path?: string | null }
  | { type: 'CLEAR_REVIEW_FOCUS' }
  | { type: 'SET_DIFF_VIEW'; mode: DiffViewMode }
  | { type: 'TOGGLE_COMMAND_PALETTE' }
  | { type: 'CLOSE_COMMAND_PALETTE' }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'TOGGLE_SPEC_MODE' }
  | {
      type: 'SESSION_SET_INTERACTION_MODE';
      appSessionId: string;
      interactionMode: SessionSummary['interactionMode'];
    }
  | { type: 'TOGGLE_SETTINGS' }
  | { type: 'TOGGLE_MISSION_CONTROL' }
  | { type: 'START_CHAT'; cwd: string; branch?: string }
  | { type: 'SEED_COMPOSER'; text: string }
  | { type: 'CLEAR_COMPOSER_SEED' }
  | { type: 'SESSION_NOTE_ADD'; appSessionId: string; text: string }
  | { type: 'SESSION_NOTE_MARK_USED'; appSessionId: string; noteId: string }
  | { type: 'SESSION_NOTE_REMOVE'; appSessionId: string; noteId: string }
  | { type: 'ADD_WORKSPACE'; cwd: string }
  | { type: 'TOGGLE_BROWSER' }
  | { type: 'SET_BROWSER_OPEN'; open: boolean }
  | { type: 'BROWSER_UPDATED'; browser: BrowserState }
  | {
      type: 'BROWSER_NAVIGATED';
      appSessionId: string;
      browserSessionId: string;
      url: string;
      canGoBack?: boolean;
      canGoForward?: boolean;
    }
  | { type: 'BROWSER_CLOSED'; appSessionId: string }
  | { type: 'BROWSER_ERROR'; appSessionId?: string; message: string }
  | { type: 'TOGGLE_DESIGN_MODE'; appSessionId: string }
  | { type: 'SET_DESIGN_MODE'; appSessionId: string; open: boolean }
  | { type: 'SET_THEME'; theme: Partial<ThemeConfig> }
  | { type: 'SELECT_FEATURE'; id: string | null }
  | { type: 'SELECT_CHILD'; selection: ChildSelection | null; requestId?: string }

  // Models / per-agent config
  | { type: 'MODELS_LIST'; models: ModelInfo[] }
  | { type: 'SKILLS_LIST'; skills: SkillInfo[]; providerSessionId: string | null }
  | { type: 'FACTORY_DEFAULTS'; defaults: FactoryDefaultSettings }
  | { type: 'SET_AGENT_MODEL'; agent: AgentKind; modelId?: string }
  | { type: 'SET_AGENT_REASONING'; agent: AgentKind; reasoning: ReasoningEffort }
  | { type: 'SESSION_SET_MODEL'; appSessionId: string; modelId?: string }
  | { type: 'SESSION_SET_REASONING'; appSessionId: string; reasoning: ReasoningEffort }
  | { type: 'SET_COMPACTION_MODEL_GLOBAL'; compactionModel: string }
  | { type: 'SET_COMPACTION_TOKEN_LIMIT_GLOBAL'; limit?: number }
  | { type: 'SET_COMPACTION_TOKEN_LIMIT_FOR_MODEL'; modelId: string; limit?: number }
  | { type: 'SET_LIVE_ENTER_BEHAVIOR'; behavior: LiveEnterBehavior }
  | { type: 'SET_IMAGE_PASTE_QUALITY'; quality: ImagePasteQuality }
  | { type: 'SET_DEFAULT_AUTONOMY'; autonomy: Autonomy }
  | { type: 'SET_DRAFT_AUTONOMY'; autonomy: Autonomy }
  | { type: 'AUTONOMY_UPDATE_REQUESTED'; appSessionId: string; autonomy: Autonomy }
  | { type: 'AUTONOMY_UPDATE_SETTLED'; appSessionId: string };

const defaultTheme: ThemeConfig = {
  mode: 'dark',
  appIconMode: 'system',
  accent: '#f2f2f2',
  bg: '#0a0a0a',
  fg: '#ededed',
  surface: '#111111',
  border: '#1f1f1f',
  uiFont: 'system',
  uiFontSize: 14,
  codeFontSize: 12,
  translucentSidebar: false,
  diffStyle: 'soft',
  contrast: 100,
};

const AGENT_CONFIG_STORAGE_KEY = 'droid-agent-config-v2';
const defaultAgentConfig: AgentConfig = {
  primary: { modelId: undefined, reasoning: 'high' },
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

// Accents that shipped as the old fixed-orange default. A saved theme still
// carrying one of these was never deliberately colored by the user, so migrate
// it to a theme-matched neutral and let the monochrome scale show through.
const LEGACY_DEFAULT_ACCENTS = new Set(['#ee6018', '#ff5d2e']);
const THEME_ACCENT_MIGRATED_KEY = 'droid-theme-accent-migrated';
const THEME_LIGHT_PRESET_MIGRATED_KEY = 'droid-theme-light-preset-migrated';

function neutralAccentFor(bg: string): string {
  const r = parseInt(bg.slice(1, 3), 16);
  const g = parseInt(bg.slice(3, 5), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return Number.isFinite(lum) && lum >= 0.4 ? '#1a1a1a' : '#f2f2f2';
}

export function normalizeDiffStyle(value: unknown): DiffStyle {
  if (value === 'focused' || value === 'symbol') return 'focused';
  return 'soft';
}

function loadTheme(): ThemeConfig {
  try {
    const storage = getLocalStorage();
    const saved = storage?.getItem('droid-theme');
    const theme = saved ? { ...defaultTheme, ...JSON.parse(saved) } : { ...defaultTheme };
    theme.diffStyle = normalizeDiffStyle(theme.diffStyle);
    theme.appIconMode = normalizeAppIconMode(theme.appIconMode);
    // One-time migration: a saved accent still carrying an old fixed-orange
    // default was never deliberately chosen, so neutralize it once. Keying off a
    // persisted flag (not the accent value) lets a user later pick that same
    // orange from the preset palette and have the choice stick across reloads.
    if (storage && storage.getItem(THEME_ACCENT_MIGRATED_KEY) !== '1') {
      // Migration writes are isolated so a storage failure (quota/restricted)
      // never discards the theme we already parsed successfully above.
      try {
        if (saved && LEGACY_DEFAULT_ACCENTS.has(String(theme.accent).toLowerCase())) {
          theme.accent = neutralAccentFor(theme.bg);
          storage.setItem('droid-theme', JSON.stringify(theme));
        }
        storage.setItem(THEME_ACCENT_MIGRATED_KEY, '1');
      } catch {
        /* migration write failed; retry on a later load */
      }
    }
    // One-time migration: a saved theme still matching the old white-on-white
    // light preset exactly was never customized, so swap it to the readable
    // warm-grey palette. Same persisted-flag pattern as the accent migration.
    if (storage && storage.getItem(THEME_LIGHT_PRESET_MIGRATED_KEY) !== '1') {
      try {
        if (saved) {
          const migrated = migrateLegacyLightPreset(theme);
          if (migrated !== theme) {
            theme.bg = migrated.bg;
            theme.fg = migrated.fg;
            theme.surface = migrated.surface;
            theme.border = migrated.border;
            theme.accent = migrated.accent;
            storage.setItem('droid-theme', JSON.stringify(theme));
          }
        }
        storage.setItem(THEME_LIGHT_PRESET_MIGRATED_KEY, '1');
      } catch {
        /* migration write failed; retry on a later load */
      }
    }
    return theme;
  } catch {
    /* ignore */
  }
  return defaultTheme;
}

function loadAgentConfig(): AgentConfig {
  try {
    const storage = getLocalStorage();
    if (!storage) return defaultAgentConfig;
    const raw = storage.getItem(AGENT_CONFIG_STORAGE_KEY);
    if (!raw) return defaultAgentConfig;
    const parsed = JSON.parse(raw) as Partial<Record<AgentKind, Partial<AgentModelConfig>>>;
    return {
      primary: readAgentConfig(parsed.primary, defaultAgentConfig.primary),
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
const LIVE_ENTER_BEHAVIOR_STORAGE_KEY = 'droid-live-enter-behavior';
const IMAGE_PASTE_QUALITY_STORAGE_KEY = 'droid-image-paste-quality';
const DIFF_VIEW_STORAGE_KEY = 'droid-diff-view';
const REVIEW_SCOPE_STORAGE_KEY = 'droid-review-scope';
const WORKSPACES_STORAGE_KEY = 'droid-workspaces';
const SESSION_LAST_SEEN_STORAGE_KEY = 'droid-session-last-seen-v1';
const UI_STATE_STORAGE_KEY = 'droid-ui-state-v2';
const BROWSER_VIEWPORT_MODES = new Set<BrowserViewportMode>([
  'fit',
  'desktop',
  'laptop',
  'tablet',
  'mobile',
  'custom',
]);

interface PersistedUiState {
  activeAppSessionId: string | null;
  rightPanelOpen: boolean;
  utilityPanels: Record<string, UtilityPanelState>;
  sidebarCollapsed: boolean;
  specMode: boolean;
  missionControlMode: boolean;
  browsers: Record<string, BrowserState>;
  browserOpenKeys: Record<string, boolean>;
  selectedFeatureId: string | null;
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

// Compaction token limit persistence and snapshot semantics live in
// lib/compactionSettings.ts; the store only wires them into state changes.

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

function normalizeImagePasteQuality(value: unknown): ImagePasteQuality {
  return value === 'high' || value === 'compact' ? value : 'original';
}

function loadImagePasteQuality(): ImagePasteQuality {
  try {
    return normalizeImagePasteQuality(getLocalStorage()?.getItem(IMAGE_PASTE_QUALITY_STORAGE_KEY));
  } catch {
    return 'original';
  }
}

function saveImagePasteQuality(value: ImagePasteQuality): ImagePasteQuality {
  const quality = normalizeImagePasteQuality(value);
  try {
    getLocalStorage()?.setItem(IMAGE_PASTE_QUALITY_STORAGE_KEY, quality);
  } catch {
    /* ignore */
  }
  return quality;
}

function loadDiffView(): DiffViewMode {
  try {
    return getLocalStorage()?.getItem(DIFF_VIEW_STORAGE_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

function saveDiffView(value: DiffViewMode): DiffViewMode {
  const mode = value === 'split' ? 'split' : 'unified';
  try {
    getLocalStorage()?.setItem(DIFF_VIEW_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  return mode;
}

function loadReviewScope(): DiffScope {
  try {
    const raw = getLocalStorage()?.getItem(REVIEW_SCOPE_STORAGE_KEY) as DiffScope | null;
    return raw && DIFF_SCOPES.includes(raw) ? raw : 'unstaged';
  } catch {
    return 'unstaged';
  }
}

function saveReviewScope(value: DiffScope): DiffScope {
  const scope = DIFF_SCOPES.includes(value) ? value : 'unstaged';
  try {
    getLocalStorage()?.setItem(REVIEW_SCOPE_STORAGE_KEY, scope);
  } catch {
    /* ignore */
  }
  return scope;
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
      activeAppSessionId:
        typeof parsed.activeAppSessionId === 'string' ? parsed.activeAppSessionId : null,
      rightPanelOpen:
        typeof parsed.rightPanelOpen === 'boolean' ? parsed.rightPanelOpen : undefined,
      utilityPanels: sanitizeUtilityPanels(parsed.utilityPanels),
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === 'boolean' ? parsed.sidebarCollapsed : undefined,
      specMode: typeof parsed.specMode === 'boolean' ? parsed.specMode : undefined,
      missionControlMode:
        typeof parsed.missionControlMode === 'boolean' ? parsed.missionControlMode : undefined,
      browsers: loadPersistedBrowsers(parsed.browsers),
      browserOpenKeys: loadPersistedBrowserOpenKeys(parsed.browserOpenKeys),
      selectedFeatureId:
        typeof parsed.selectedFeatureId === 'string' ? parsed.selectedFeatureId : null,
    };
  } catch {
    return {};
  }
}

function savePersistedUiState(state: AppState): void {
  const snapshot: PersistedUiState = {
    activeAppSessionId: state.activeAppSessionId,
    rightPanelOpen: state.rightPanelOpen,
    utilityPanels: persistUtilityPanels(state.utilityPanels),
    sidebarCollapsed: state.sidebarCollapsed,
    specMode: state.specMode,
    missionControlMode: state.missionControlMode,
    browsers: persistBrowsers(state.browsers),
    browserOpenKeys: state.browserOpenKeys,
    selectedFeatureId: state.selectedFeatureId,
  };
  try {
    getLocalStorage()?.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* ignore */
  }
}

function loadSessionLastSeen(): Record<string, number> {
  try {
    const raw = getLocalStorage()?.getItem(SESSION_LAST_SEEN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function saveSessionLastSeen(map: Record<string, number>): void {
  try {
    getLocalStorage()?.setItem(SESSION_LAST_SEEN_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function sanitizeAgentConfig(config: AgentConfig, models: ModelInfo[]): AgentConfig {
  if (models.length === 0) return config;
  return {
    primary: sanitizeAgent(config.primary, models),
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

function applySessionOverride(
  summary: SessionSummary,
  override?: { modelId?: string; reasoningEffort?: ReasoningEffort },
): SessionSummary {
  if (!override) return summary;
  const next = { ...summary };
  if ('modelId' in override) next.modelId = override.modelId;
  if (override.reasoningEffort !== undefined) next.reasoningEffort = override.reasoningEffort;
  return next;
}

const persistedUiState = loadPersistedUiState();
const sessionSnapshot = loadSessionSnapshot();

export const initialState: AppState = {
  connection: 'idle',
  sessions: sessionSnapshot?.sessions ?? {},
  sessionOrder: sessionSnapshot?.sessionOrder ?? [],
  listConfirmedSessionIds: sessionSnapshot?.sessionOrder ?? null,
  activeAppSessionId: persistedUiState.activeAppSessionId ?? null,
  sessionLastSeen: loadSessionLastSeen(),
  transcripts: sessionSnapshot?.transcript
    ? { [sessionSnapshot.transcript.appSessionId]: sessionSnapshot.transcript.events }
    : {},
  progress: {},
  childSessions: {},
  historyLoaded: {},
  historyCursor: {},
  historyLoadingOlder: {},
  sessionRestore: {},
  childAccess: {},
  childRuntime: {},
  pendingPermission: null,
  pendingQuestion: null,
  contextStats: { primary: {}, child: {} },
  specPlans: {},
  sessionSpecs: {},
  specWikiAppSessionId: null,
  promptQueue: {},
  sessionNotes: loadSessionNotes(),
  rightPanelOpen: persistedUiState.rightPanelOpen ?? true,
  utilityPanels: persistedUiState.utilityPanels ?? {},
  sidebarCollapsed: persistedUiState.sidebarCollapsed ?? false,
  specMode: persistedUiState.specMode ?? false,
  settingsOpen: false,
  commandPaletteOpen: false,
  theme: loadTheme(),
  missionControlMode: persistedUiState.missionControlMode ?? false,
  draftChat: null,
  defaultAutonomy: loadDefaultAutonomy(),
  draftAutonomy: null,
  pendingAutonomy: {},
  composerSeed: null,
  workspaceCwds: loadWorkspaceCwds(),
  browserOpen: false,
  browserOpenKeys: persistedUiState.browserOpenKeys ?? {},
  browsers: persistedUiState.browsers ?? {},
  browserErrors: {},
  browserGlobalError: undefined,
  designModes: {},
  selectedFeatureId: persistedUiState.selectedFeatureId ?? null,
  selectedChild: null,
  models: [],
  compactionModel: loadCompactionModel(),
  compactionTokenLimit: loadCompactionTokenLimit(),
  compactionTokenLimitPerModel: loadCompactionTokenLimitPerModel(),
  compactionSettingsRev: 0,
  liveEnterBehavior: loadLiveEnterBehavior(),
  imagePasteQuality: loadImagePasteQuality(),
  reviewOpenAppSessionId: null,
  reviewScope: loadReviewScope(),
  reviewFocusPath: null,
  reviewFocusRequestId: 0,
  diffView: loadDiffView(),
  sessionSettingOverrides: {},
  skills: [],
  skillsProviderSessionId: undefined,
  agentConfig: loadAgentConfig(),
  pendingCompose: {},
};

function progressKey(entry: ProgressEntry): string {
  return `${entry.timestamp}|${entry.type}|${entry.featureId ?? ''}|${entry.workerChildSessionId ?? ''}|${entry.title ?? ''}`;
}

function activeBrowserKey(state: AppState): string | undefined {
  if (!state.activeAppSessionId) return undefined;
  // Browser state and open-keys are keyed by the stable app session id
  // (`appSessionId`), matching the backend; the provider session is swapped by
  // compaction and would desync the open state from the backend's updates.
  return state.sessions[state.activeAppSessionId]?.appSessionId ?? state.activeAppSessionId;
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

function closeActiveUtilityPanel(state: AppState): AppState {
  const appSessionId = state.activeAppSessionId;
  if (!appSessionId) return state;
  const current = utilityPanelForSession(state.utilityPanels, appSessionId);
  const panel = setUtilityPanelOpen(current, false);
  return panel === current
    ? state
    : { ...state, utilityPanels: { ...state.utilityPanels, [appSessionId]: panel } };
}

function withChildAccess(
  state: AppState,
  parentAppSessionId: string,
  childSessionId: string,
  access: ChildAccess,
): AppState {
  const parent = state.childAccess[parentAppSessionId] ?? {};
  return {
    ...state,
    childAccess: {
      ...state.childAccess,
      [parentAppSessionId]: { ...parent, [childSessionId]: access },
    },
  };
}

function withoutChildAccess(
  state: AppState,
  parentAppSessionId: string,
  childSessionId: string,
): AppState {
  const parent = { ...(state.childAccess[parentAppSessionId] ?? {}) };
  delete parent[childSessionId];
  const childAccess = { ...state.childAccess };
  if (Object.keys(parent).length === 0) delete childAccess[parentAppSessionId];
  else childAccess[parentAppSessionId] = parent;
  return { ...state, childAccess };
}

function withChildRuntime(
  state: AppState,
  parentAppSessionId: string,
  childSessionId: string,
  runtime: ChildRuntimeState,
): AppState {
  const parent = state.childRuntime[parentAppSessionId] ?? {};
  return {
    ...state,
    childRuntime: {
      ...state.childRuntime,
      [parentAppSessionId]: { ...parent, [childSessionId]: runtime },
    },
  };
}

function invalidateSelectedChildOpening(state: AppState): AppState {
  const selected = state.selectedChild;
  if (!selected) return state;
  const access = state.childAccess[selected.parentAppSessionId]?.[selected.childSessionId];
  return access?.state === 'opening'
    ? withChildAccess(state, selected.parentAppSessionId, selected.childSessionId, {
        state: 'closed',
        requestId: null,
      })
    : state;
}

function withHistoricalCompactionGeneration(
  state: AppState,
  appSessionId: string,
  transcript: TranscriptEvent[],
): AppState {
  const session = state.sessions[appSessionId];
  if (!session) return state;

  const compactionMarkers = transcript.filter(
    (event) => event.kind === 'compaction' && event.role === 'primary',
  );
  const restoredCompactions = Math.max(
    compactionMarkers.filter((event) => event.id.startsWith('compaction-')).length,
    compactionMarkers.filter((event) => !event.id.startsWith('compaction-')).length,
  );
  const currentCompactions = session.autoCompactions ?? 0;
  if (restoredCompactions <= currentCompactions) return state;

  const primaryContext = Object.fromEntries(
    Object.entries(state.contextStats.primary).filter(([id]) => id !== appSessionId),
  );
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [appSessionId]: {
        ...session,
        autoCompactions: restoredCompactions,
        contextTokens: 0,
        contextRemainingTokens: undefined,
        contextAccuracy: undefined,
        contextUpdatedAt: undefined,
      },
    },
    contextStats: { ...state.contextStats, primary: primaryContext },
  };
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
    case 'SET_CONNECTION': {
      if (action.status === 'connected')
        return { ...state, connection: action.status, connectionError: action.message };
      const next = invalidateSelectedChildOpening(state);
      return {
        ...next,
        connection: action.status,
        connectionError: action.message,
        selectedChild: null,
        childAccess: {},
        childRuntime: {},
        contextStats: { ...next.contextStats, child: {} },
      };
    }

    case 'SESSION_CREATED': {
      const pending = state.pendingCompose[action.clientRef];
      // `session.created` is also emitted when an existing session resumes.
      // Only a create matching this renderer's pending compose may take focus;
      // background resumes must never replace the chat the user selected.
      const shouldActivate = pending !== undefined;
      const targetIsActive = state.activeAppSessionId === action.session.appSessionId;
      const childReset =
        shouldActivate || targetIsActive ? invalidateSelectedChildOpening(state) : state;
      const childAccess = { ...childReset.childAccess };
      const childRuntime = { ...childReset.childRuntime };
      delete childAccess[action.session.appSessionId];
      delete childRuntime[action.session.appSessionId];
      const order = state.sessionOrder.includes(action.session.appSessionId)
        ? state.sessionOrder
        : [action.session.appSessionId, ...state.sessionOrder];

      // Seed the first user message: the goal is the user's opening prompt and the
      // backend never echoes it back, so without this the first message never shows.
      let transcripts = state.transcripts;
      const hasTranscript = (state.transcripts[action.session.appSessionId]?.length ?? 0) > 0;
      if (action.session.goal && !hasTranscript) {
        const seed: TranscriptEvent = {
          id: `seed-${action.session.appSessionId}`,
          appSessionId: action.session.appSessionId,
          sourceSessionId: 'user',
          role: 'primary',
          ts: action.session.createdAt || Date.now(),
          kind: 'text',
          text: pending ? pending.text : action.session.goal,
          author: 'user',
          skills: pending?.skills.length ? pending.skills : undefined,
          files: pending?.files.length ? pending.files : undefined,
        };
        transcripts = { ...state.transcripts, [action.session.appSessionId]: [seed] };
      }

      const pendingCompose = pending
        ? Object.fromEntries(
            Object.entries(state.pendingCompose).filter(([k]) => k !== action.clientRef),
          )
        : state.pendingCompose;

      const next = {
        ...childReset,
        sessions: {
          ...state.sessions,
          [action.session.appSessionId]: applySessionOverride(
            action.session,
            state.sessionSettingOverrides[action.session.appSessionId],
          ),
        },
        sessionOrder: order,
        transcripts,
        activeAppSessionId: shouldActivate ? action.session.appSessionId : state.activeAppSessionId,
        draftChat: shouldActivate ? null : state.draftChat,
        draftAutonomy: shouldActivate ? null : state.draftAutonomy,
        selectedChild: shouldActivate || targetIsActive ? null : childReset.selectedChild,
        // A pending review-focus request belongs to the session that issued
        // it; a different session becoming active must not inherit it.
        reviewFocusPath:
          shouldActivate && action.session.appSessionId !== state.activeAppSessionId
            ? null
            : state.reviewFocusPath,
        childAccess,
        childRuntime,
        pendingCompose,
        // A foreground chat just created by this renderer is already seen.
        sessionLastSeen: shouldActivate
          ? {
              ...state.sessionLastSeen,
              [action.session.appSessionId]: action.session.updatedAt,
            }
          : state.sessionLastSeen,
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

    case 'SESSION_UPDATED': {
      const previous = state.sessions[action.session.appSessionId];
      const incoming = applySessionOverride(
        action.session,
        state.sessionSettingOverrides[action.session.appSessionId],
      );
      // Compaction generations are monotonic. A delayed resume summary must not
      // put a restored session back on generation zero after history already
      // proved that compactions occurred.
      const m =
        previous && (previous.autoCompactions ?? 0) > (incoming.autoCompactions ?? 0)
          ? {
              ...incoming,
              autoCompactions: previous.autoCompactions,
              contextTokens: previous.contextTokens,
              contextRemainingTokens: previous.contextRemainingTokens,
              contextAccuracy: previous.contextAccuracy,
              contextUpdatedAt: previous.contextUpdatedAt,
            }
          : incoming;
      const previousCompactions =
        (previous?.compactedFromProviderSessionIds?.length ?? 0) + (previous?.autoCompactions ?? 0);
      const nextCompactions =
        (m.compactedFromProviderSessionIds?.length ?? 0) + (m.autoCompactions ?? 0);
      const contextStats =
        nextCompactions > previousCompactions
          ? {
              ...state.contextStats,
              primary: Object.fromEntries(
                Object.entries(state.contextStats.primary).filter(
                  ([appSessionId]) => appSessionId !== m.appSessionId,
                ),
              ),
            }
          : state.contextStats;
      // A pending autonomy change settles when the confirmed summary reaches
      // the requested level, or when the level changed through another path.
      const requestedAutonomy =
        m.appSessionId in state.pendingAutonomy ? state.pendingAutonomy[m.appSessionId] : undefined;
      const autonomySettled =
        requestedAutonomy !== undefined &&
        (m.autonomy === requestedAutonomy ||
          (m.appSessionId in state.sessions && m.autonomy !== previous.autonomy));
      const pendingAutonomy = autonomySettled
        ? Object.fromEntries(
            Object.entries(state.pendingAutonomy).filter(([id]) => id !== m.appSessionId),
          )
        : state.pendingAutonomy;
      return {
        ...state,
        sessions: { ...state.sessions, [m.appSessionId]: m },
        contextStats,
        pendingAutonomy,
      };
    }

    case 'SESSION_CLOSED': {
      const childAccess = { ...state.childAccess };
      const childRuntime = { ...state.childRuntime };
      const childContext = { ...state.contextStats.child };
      delete childAccess[action.appSessionId];
      delete childRuntime[action.appSessionId];
      delete childContext[action.appSessionId];
      return {
        ...state,
        childAccess,
        childRuntime,
        contextStats: { ...state.contextStats, child: childContext },
        pendingAutonomy: Object.fromEntries(
          Object.entries(state.pendingAutonomy).filter(([id]) => id !== action.appSessionId),
        ),
        selectedChild:
          state.selectedChild?.parentAppSessionId === action.appSessionId
            ? null
            : state.selectedChild,
      };
    }

    case 'SESSION_FEATURES': {
      const mid = action.appSessionId;
      const existing = state.sessions[mid];
      if (!existing) return state;
      return {
        ...state,
        sessions: { ...state.sessions, [mid]: { ...existing, features: action.features } },
      };
    }

    case 'SESSION_PROGRESS': {
      const mid = action.appSessionId;
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

    case 'SESSION_CHILD': {
      const child = action.child;
      const parent = state.childSessions[child.parentAppSessionId] ?? {};
      const runtimeParent = state.childRuntime[child.parentAppSessionId] ?? {};
      const previousRuntime = runtimeParent[child.childSessionId];
      if (previousRuntime && action.runtimeGeneration < previousRuntime.runtimeGeneration)
        return state;
      const clearContext =
        !action.runtimeAvailable ||
        (previousRuntime !== undefined &&
          action.runtimeGeneration > previousRuntime.runtimeGeneration);
      const contextParent = state.contextStats.child[child.parentAppSessionId] ?? {};
      let next = {
        ...state,
        childSessions: {
          ...state.childSessions,
          [child.parentAppSessionId]: {
            ...parent,
            [child.childSessionId]: child,
          },
        },
        contextStats: clearContext
          ? {
              ...state.contextStats,
              child: {
                ...state.contextStats.child,
                [child.parentAppSessionId]: Object.fromEntries(
                  Object.entries(contextParent).filter(
                    ([childSessionId]) => childSessionId !== child.childSessionId,
                  ),
                ),
              },
            }
          : state.contextStats,
      };
      if (
        // Keep the existence guard because the following comparison dereferences previousRuntime.
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
        previousRuntime &&
        action.runtimeGeneration === previousRuntime.runtimeGeneration &&
        action.runtimeAvailable === previousRuntime.available
      )
        return next;
      next = {
        ...next,
        childRuntime: {
          ...state.childRuntime,
          [child.parentAppSessionId]: {
            ...runtimeParent,
            [child.childSessionId]: {
              available: action.runtimeAvailable,
              runtimeGeneration: action.runtimeGeneration,
            },
          },
        },
      };
      const access = state.childAccess[child.parentAppSessionId]?.[child.childSessionId];
      if (!access) return next;
      if (!action.runtimeAvailable && (access.state === 'opening' || access.state === 'ready'))
        return withChildAccess(next, child.parentAppSessionId, child.childSessionId, {
          state: 'closed',
          requestId: null,
        });
      if (action.runtimeAvailable && access.state === 'ready')
        return withChildAccess(next, child.parentAppSessionId, child.childSessionId, {
          ...access,
          runtimeGeneration: action.runtimeGeneration,
        });
      return next;
    }

    case 'CHILD_UPDATED': {
      if (
        state.selectedChild?.parentAppSessionId !== action.parentAppSessionId ||
        state.selectedChild.childSessionId !== action.childSessionId
      )
        return state;
      const current = state.childAccess[action.parentAppSessionId]?.[action.childSessionId];
      if (current?.state !== 'opening' || current.requestId !== action.requestId) return state;
      const runtime = state.childRuntime[action.parentAppSessionId]?.[action.childSessionId];
      if (
        action.access === 'ready' &&
        runtime &&
        (action.runtimeGeneration < runtime.runtimeGeneration ||
          (action.runtimeGeneration === runtime.runtimeGeneration && !runtime.available))
      )
        return state;
      const settled = withChildAccess(
        state,
        action.parentAppSessionId,
        action.childSessionId,
        action.access === 'ready'
          ? {
              state: 'ready',
              requestId: action.requestId,
              runtimeGeneration: action.runtimeGeneration,
            }
          : { state: 'history', requestId: action.requestId },
      );
      return action.access === 'ready'
        ? withChildRuntime(settled, action.parentAppSessionId, action.childSessionId, {
            available: true,
            runtimeGeneration: action.runtimeGeneration,
          })
        : settled;
    }

    case 'CHILD_ERROR': {
      if (action.operation !== 'open' || !action.requestId) return state;
      if (
        state.selectedChild?.parentAppSessionId !== action.parentAppSessionId ||
        state.selectedChild.childSessionId !== action.childSessionId
      )
        return state;
      const current = state.childAccess[action.parentAppSessionId]?.[action.childSessionId];
      if (current?.state !== 'opening' || current.requestId !== action.requestId) return state;
      return withChildAccess(state, action.parentAppSessionId, action.childSessionId, {
        state: 'failed',
        requestId: action.requestId,
      });
    }

    case 'SESSION_TOKENS': {
      const mid = action.appSessionId;
      const existing = state.sessions[mid];
      if (!existing) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
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
      const existing = state.sessions[action.appSessionId];
      if (action.parentAppSessionId && action.childSessionId) {
        const parent = state.contextStats.child[action.parentAppSessionId] ?? {};
        return {
          ...state,
          contextStats: {
            ...state.contextStats,
            child: {
              ...state.contextStats.child,
              [action.parentAppSessionId]: {
                ...parent,
                [action.childSessionId]: action.stats,
              },
            },
          },
        };
      }
      return {
        ...state,
        contextStats: {
          ...state.contextStats,
          primary: { ...state.contextStats.primary, [action.appSessionId]: action.stats },
        },
        sessions: existing
          ? {
              ...state.sessions,
              [action.appSessionId]: {
                ...existing,
                contextTokens: action.stats.used,
                contextRemainingTokens: action.stats.remaining,
                maxContextTokens: action.stats.limit,
                contextAccuracy: action.stats.accuracy,
                contextUpdatedAt: action.stats.updatedAt,
              },
            }
          : state.sessions,
      };
    }

    case 'SESSION_TRANSCRIPT': {
      const ev = action.event;
      const mid = ev.appSessionId;
      const prev = state.transcripts[mid] ?? [];
      if (prev.some((event) => event.id === ev.id)) return state;

      // Delta merging: if the last event has the same kind + sourceSessionId, append text
      // Only merge backend streaming deltas (author is absent); do NOT merge explicit user echoes
      const last = prev[prev.length - 1];
      if (
        last &&
        !ev.author && // backend streaming delta (user echoes have author:'user')
        last.kind === ev.kind &&
        last.sourceSessionId === ev.sourceSessionId &&
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
        last.sourceSessionId === ev.sourceSessionId &&
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
      const prev = state.promptQueue[action.appSessionId] ?? [];
      return {
        ...state,
        promptQueue: { ...state.promptQueue, [action.appSessionId]: [...prev, action.prompt] },
      };
    }

    case 'REMOVE_QUEUED_PROMPT': {
      const prev = state.promptQueue[action.appSessionId] ?? [];
      return {
        ...state,
        promptQueue: {
          ...state.promptQueue,
          [action.appSessionId]: prev.filter((p) => p.id !== action.id),
        },
      };
    }

    case 'REORDER_QUEUE': {
      const prev = state.promptQueue[action.appSessionId] ?? [];
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
      return { ...state, promptQueue: { ...state.promptQueue, [action.appSessionId]: next } };
    }

    case 'SPEC_SET': {
      const prev = state.sessionSpecs[action.appSessionId];
      if (
        // Keep the existence guard because the following comparisons dereference prev.
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
        prev &&
        prev.content === action.content &&
        prev.path === action.path &&
        prev.title === action.title
      ) {
        return state;
      }
      return {
        ...state,
        sessionSpecs: {
          ...state.sessionSpecs,
          [action.appSessionId]: {
            path: action.path,
            title: action.title,
            content: action.content,
          },
        },
      };
    }

    case 'SPEC_OPEN_WIKI':
      return { ...state, specWikiAppSessionId: action.appSessionId };

    case 'SPEC_CLOSE_WIKI':
      return { ...state, specWikiAppSessionId: null };

    case 'SESSION_PERMISSION': {
      const r = action.request;
      const specPlans =
        r.kind === 'spec' && r.plan
          ? { ...state.specPlans, [r.appSessionId]: r.plan }
          : state.specPlans;
      // Seed the persistent spec/plan so the inline card and wiki reader work
      // immediately (a richer spec file, if any, overrides this via SPEC_SET).
      // Seed/refresh the persistent spec whenever a (revised) plan arrives so the
      // card/wiki never go stale. The path is preserved; ChatView reloads the
      // file on revision and overrides with the richer on-disk content.
      const existingSpec = state.sessionSpecs[r.appSessionId];
      const sessionSpecs =
        (r.kind === 'spec' || r.kind === 'mission_plan') &&
        r.plan &&
        existingSpec?.content !== r.plan
          ? {
              ...state.sessionSpecs,
              [r.appSessionId]: { path: existingSpec?.path, title: r.title, content: r.plan },
            }
          : state.sessionSpecs;
      return { ...state, pendingPermission: r, specPlans, sessionSpecs };
    }

    case 'SESSION_QUESTION':
      return { ...state, pendingQuestion: action.question };

    case 'SESSION_CREATE_FAILED':
      return {
        ...state,
        pendingCompose: Object.fromEntries(
          Object.entries(state.pendingCompose).filter(
            ([clientRef]) => clientRef !== action.clientRef,
          ),
        ),
      };

    case 'SESSION_ERROR': {
      let next = state;
      if (action.appSessionId && state.sessions[action.appSessionId]) {
        const m = state.sessions[action.appSessionId];
        next = {
          ...state,
          sessions: {
            ...state.sessions,
            [action.appSessionId]: { ...m, phase: 'failed' as const },
          },
        };
      }
      return next;
    }

    case 'SESSION_LIST': {
      const incoming = new Set(action.sessions.map((m) => m.appSessionId));
      // Every list is a fresh scan of what exists, so it is authoritative for
      // the rows the previous listing confirmed: drop confirmed rows it no
      // longer reports (deleted outside the app, or pruned from a hydrated
      // snapshot). Rows added locally this run are not confirmed yet and
      // survive.
      const confirmed = state.listConfirmedSessionIds;
      const map: Record<string, SessionSummary> = {};
      for (const [id, summary] of Object.entries(state.sessions)) {
        if (confirmed?.includes(id) && !incoming.has(id)) continue;
        map[id] = summary;
      }
      for (const m of action.sessions) {
        map[m.appSessionId] = applySessionOverride(
          m,
          state.sessionSettingOverrides[m.appSessionId],
        );
      }
      const order = [
        ...new Set([
          ...action.sessions.map((m) => m.appSessionId),
          ...state.sessionOrder,
          ...Object.keys(state.sessions),
        ]),
      ]
        .filter((id) => map[id])
        .sort((a, b) => map[b].updatedAt - map[a].updatedAt);
      // Seed last-seen for sessions this client has never tracked so existing
      // history is not retroactively marked unread; only activity that arrives
      // after this point (a newer updatedAt) flips a row to unread.
      const seededLastSeen = { ...state.sessionLastSeen };
      for (const m of action.sessions) {
        if (seededLastSeen[m.appSessionId] === undefined) {
          seededLastSeen[m.appSessionId] = m.updatedAt;
        }
      }
      // If the active session was pruned above (a hydrated snapshot row the
      // sidecar no longer reports), clear the dangling id so the UI does not
      // point at a session that no longer exists.
      const mapById: Partial<Record<string, SessionSummary>> = map;
      const activeAppSessionId =
        state.activeAppSessionId !== null && mapById[state.activeAppSessionId] !== undefined
          ? state.activeAppSessionId
          : null;
      return {
        ...state,
        sessions: map,
        sessionOrder: order,
        sessionLastSeen: seededLastSeen,
        listConfirmedSessionIds: action.sessions.map((m) => m.appSessionId),
        activeAppSessionId,
      };
    }

    case 'SESSION_HISTORY_LOADING_OLDER':
      return {
        ...state,
        historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: true },
      };

    case 'SESSION_RESTORE_START': {
      const prev = state.sessionRestore[action.appSessionId];
      return {
        ...state,
        sessionRestore: {
          ...state.sessionRestore,
          [action.appSessionId]: {
            status: 'loading',
            loadedCount: prev?.loadedCount ?? 0,
            hasMore: prev?.hasMore ?? false,
          },
        },
      };
    }

    case 'SESSION_HISTORY_FAILED': {
      const prev = state.sessionRestore[action.appSessionId];
      return {
        ...state,
        historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: false },
        sessionRestore: {
          ...state.sessionRestore,
          [action.appSessionId]: {
            status: 'failed',
            loadedCount: prev?.loadedCount ?? 0,
            hasMore: prev?.hasMore ?? false,
            error: action.message,
          },
        },
      };
    }

    case 'SESSION_HISTORY': {
      const existing = state.transcripts[action.appSessionId] ?? [];
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
        return withHistoricalCompactionGeneration(
          {
            ...state,
            transcripts: changed
              ? { ...state.transcripts, [action.appSessionId]: merged }
              : state.transcripts,
            historyCursor: { ...state.historyCursor, [action.appSessionId]: action.olderCursor },
            historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: false },
            sessionRestore: {
              ...state.sessionRestore,
              [action.appSessionId]: {
                status: hasMore ? 'paged' : 'loaded',
                loadedCount: merged.length,
                hasMore,
              },
            },
          },
          action.appSessionId,
          merged,
        );
      }
      // No-clobber replace: reconcile the authoritative, correctly-ordered
      // replay page with any live events already in state (a reconnect to a
      // running session can deliver live events first, and a brand-new session
      // carries a locally seeded opening prompt).
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
      //     signature (sourceSessionId + toolUseId for tools, else
      //     sourceSessionId + author/role + kind + text) consumed once per page
      //     occurrence so a genuinely repeated message is kept. Scoping by
      //     sourceSessionId stops one child session's output masking another's.
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
      // Live primary events carry the current provider identity while restored
      // history canonicalizes that source to 'primary' (mirroring the
      // sidecar). Normalize so a reconnect-race twin matches instead of both the
      // live and persisted copy surviving and duplicating main-agent output.
      const sessionKey = (e: TranscriptEvent) =>
        e.role === 'primary' && e.sourceSessionId !== 'user' ? 'primary' : e.sourceSessionId;
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
      const transcripts = { ...state.transcripts, [action.appSessionId]: mergedTranscript };
      const historicalChildren = action.childSessions ?? [];
      const existingChildSessions = state.childSessions[action.appSessionId] ?? {};
      let childSessions = state.childSessions;
      if (historicalChildren.length > 0) {
        const byChild = { ...existingChildSessions };
        for (const child of historicalChildren)
          byChild[child.childSessionId] = byChild[child.childSessionId] ?? child;
        childSessions = {
          ...state.childSessions,
          [action.appSessionId]: byChild,
        };
      }
      const hasMore = Boolean(action.olderCursor);
      // An empty restore (e.g. a live session with no persisted history yet)
      // must not wipe progress already delivered by live events; only adopt the
      // replayed progress when it actually carries entries.
      const existingProgress = state.progress[action.appSessionId] ?? [];
      const mergedProgress = action.progress.length > 0 ? action.progress : existingProgress;
      return withHistoricalCompactionGeneration(
        {
          ...state,
          progress: { ...state.progress, [action.appSessionId]: mergedProgress },
          transcripts,
          childSessions,
          historyLoaded: { ...state.historyLoaded, [action.appSessionId]: true },
          historyCursor: { ...state.historyCursor, [action.appSessionId]: action.olderCursor },
          historyLoadingOlder: { ...state.historyLoadingOlder, [action.appSessionId]: false },
          sessionRestore: {
            ...state.sessionRestore,
            [action.appSessionId]: {
              status: hasMore ? 'paged' : 'loaded',
              loadedCount: mergedTranscript.length,
              hasMore,
            },
          },
        },
        action.appSessionId,
        mergedTranscript,
      );
    }

    case 'CLEAR_PERMISSION':
      return { ...state, pendingPermission: null };

    case 'CLEAR_QUESTION':
      return { ...state, pendingQuestion: null };

    case 'SET_ACTIVE_SESSION': {
      // Stamp "seen now" on both the session being left (so responses received
      // while it was open count as read) and the one being opened (clears its
      // unread state immediately).
      const now = Date.now();
      const sessionLastSeen = { ...state.sessionLastSeen };
      if (state.activeAppSessionId && state.sessions[state.activeAppSessionId]) {
        sessionLastSeen[state.activeAppSessionId] = now;
      }
      if (action.id) sessionLastSeen[action.id] = now;
      const next = invalidateSelectedChildOpening(state);
      return {
        ...next,
        activeAppSessionId: action.id,
        sessionLastSeen,
        draftChat: null,
        draftAutonomy: null,
        selectedChild: null,
        // A pending review-focus request belongs to the session that issued
        // it; never let it fire in another session's panel after a switch.
        reviewFocusPath: action.id === state.activeAppSessionId ? state.reviewFocusPath : null,
      };
    }

    case 'MARK_ALL_SESSIONS_READ': {
      const sessionLastSeen = { ...state.sessionLastSeen };
      let changed = false;
      for (const appSessionId of state.sessionOrder) {
        const session = state.sessions[appSessionId];
        const seenAt = Math.max(action.seenAt, session.updatedAt);
        if (sessionLastSeen[appSessionId] === seenAt) continue;
        sessionLastSeen[appSessionId] = seenAt;
        changed = true;
      }
      return changed ? { ...state, sessionLastSeen } : state;
    }

    case 'SET_RIGHT_PANEL':
      return action.open
        ? closeActiveUtilityPanel({ ...state, rightPanelOpen: true })
        : { ...state, rightPanelOpen: false };

    case 'OPEN_UTILITY_TOOL': {
      const appSessionId = state.activeAppSessionId;
      if (!appSessionId) return state;
      const panel = openUtilityTool(
        state.utilityPanels[appSessionId],
        action.tool,
        () => action.tabId ?? `${action.tool}:${appSessionId}`,
        { terminalId: action.terminalId, cwd: action.cwd, filePath: action.filePath },
      );
      return {
        ...state,
        rightPanelOpen: false,
        utilityPanels: { ...state.utilityPanels, [appSessionId]: panel },
        reviewOpenAppSessionId:
          action.tool === 'review' ? appSessionId : state.reviewOpenAppSessionId,
        browserOpenKeys:
          action.tool === 'browser'
            ? withBrowserOpenKey(state.browserOpenKeys, appSessionId, true)
            : state.browserOpenKeys,
      };
    }

    case 'CLOSE_UTILITY_TAB': {
      const appSessionId = action.appSessionId ?? state.activeAppSessionId;
      if (!appSessionId) return state;
      const current = state.utilityPanels[appSessionId];
      const closing = current?.tabs.find((tab) => tab.id === action.tabId);
      const panel = closeUtilityTab(current, action.tabId);
      if (panel === current) return state;
      return {
        ...state,
        utilityPanels: { ...state.utilityPanels, [appSessionId]: panel },
        reviewOpenAppSessionId:
          closing?.tool === 'review' && state.reviewOpenAppSessionId === appSessionId
            ? null
            : state.reviewOpenAppSessionId,
        reviewFocusPath: closing?.tool === 'review' ? null : state.reviewFocusPath,
        browserOpenKeys:
          closing?.tool === 'browser'
            ? withBrowserOpenKey(state.browserOpenKeys, appSessionId, false)
            : state.browserOpenKeys,
      };
    }

    case 'ACTIVATE_UTILITY_TAB': {
      const appSessionId = state.activeAppSessionId;
      if (!appSessionId) return state;
      const current = state.utilityPanels[appSessionId];
      const panel = activateUtilityTab(current, action.tabId);
      if (panel === current) return state;
      return {
        ...state,
        rightPanelOpen: false,
        utilityPanels: { ...state.utilityPanels, [appSessionId]: panel },
      };
    }

    case 'UPDATE_UTILITY_TAB': {
      const appSessionId = action.appSessionId ?? state.activeAppSessionId;
      if (!appSessionId) return state;
      const current = state.utilityPanels[appSessionId];
      const panel = updateUtilityTab(current, action.tabId, {
        terminalId: action.terminalId,
        cwd: action.cwd,
        filePath: action.filePath,
        label: action.label,
      });
      if (panel === current) return state;
      return {
        ...state,
        utilityPanels: { ...state.utilityPanels, [appSessionId]: panel },
      };
    }

    case 'SET_UTILITY_PANEL_OPEN': {
      const appSessionId = state.activeAppSessionId;
      if (!appSessionId) return state;
      const current = utilityPanelForSession(state.utilityPanels, appSessionId);
      const panel = setUtilityPanelOpen(current, action.open);
      if (panel === current && (!action.open || !state.rightPanelOpen)) return state;
      return {
        ...state,
        rightPanelOpen: action.open ? false : state.rightPanelOpen,
        utilityPanels: { ...state.utilityPanels, [appSessionId]: panel },
      };
    }

    case 'SET_REVIEW_OPEN':
      // Closing while already closed AND no pending focus is a true no-op; bail
      // before allocating a new state object so subscribers don't re-render. The
      // reviewFocusPath check is essential: a close dispatched when the pane is
      // already shut but a focus path is still pending would otherwise skip the
      // clear and leave the stale focus request to fire on the next open.
      if (
        !action.open &&
        state.reviewOpenAppSessionId === null &&
        state.reviewFocusPath === null &&
        !utilityPanelForSession(state.utilityPanels, state.activeAppSessionId).tabs.some(
          (tab) => tab.tool === 'review',
        )
      )
        return state;
      // Scope the open state to the active session so it never leaks into the
      // next chat; switching back to this session restores it.
      if (action.open && state.activeAppSessionId) {
        const appSessionId = state.activeAppSessionId;
        return {
          ...state,
          rightPanelOpen: false,
          reviewOpenAppSessionId: appSessionId,
          utilityPanels: {
            ...state.utilityPanels,
            [appSessionId]: openUtilityTool(
              state.utilityPanels[appSessionId],
              'review',
              () => `review:${appSessionId}`,
            ),
          },
        };
      }
      return {
        ...state,
        reviewOpenAppSessionId: null,
        reviewFocusPath: null,
        utilityPanels: state.activeAppSessionId
          ? {
              ...state.utilityPanels,
              [state.activeAppSessionId]: removeUtilityTool(
                state.utilityPanels[state.activeAppSessionId],
                'review',
              ),
            }
          : state.utilityPanels,
      };

    case 'SET_REVIEW_SCOPE':
      return { ...state, reviewScope: saveReviewScope(action.scope) };

    case 'OPEN_REVIEW_AT':
      // Open the Review pane for the active session at a given scope, optionally
      // asking it to jump to a specific file once the diff list has loaded.
      if (!state.activeAppSessionId) {
        return {
          ...state,
          reviewScope: saveReviewScope(action.scope),
          reviewFocusPath: action.path ?? null,
          reviewFocusRequestId: state.reviewFocusRequestId + 1,
        };
      }
      return {
        ...state,
        rightPanelOpen: false,
        reviewOpenAppSessionId: state.activeAppSessionId,
        reviewScope: saveReviewScope(action.scope),
        reviewFocusPath: action.path ?? null,
        reviewFocusRequestId: state.reviewFocusRequestId + 1,
        utilityPanels: {
          ...state.utilityPanels,
          [state.activeAppSessionId]: openUtilityTool(
            state.utilityPanels[state.activeAppSessionId],
            'review',
            () => `review:${state.activeAppSessionId}`,
          ),
        },
      };

    case 'CLEAR_REVIEW_FOCUS':
      return state.reviewFocusPath === null ? state : { ...state, reviewFocusPath: null };

    case 'SET_DIFF_VIEW':
      return { ...state, diffView: saveDiffView(action.mode) };

    case 'TOGGLE_COMMAND_PALETTE':
      return { ...state, commandPaletteOpen: !state.commandPaletteOpen };

    case 'CLOSE_COMMAND_PALETTE':
      return { ...state, commandPaletteOpen: false };

    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };

    case 'TOGGLE_SPEC_MODE':
      return { ...state, specMode: !state.specMode };

    case 'SESSION_SET_INTERACTION_MODE': {
      // Optimistic interaction-mode flip so the spec toggle reflects instantly;
      // a later SESSION_UPDATED from the backend confirms (or corrects) it.
      const session = state.sessions[action.appSessionId];
      if (!session || session.interactionMode === action.interactionMode) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.appSessionId]: { ...session, interactionMode: action.interactionMode },
        },
      };
    }

    case 'TOGGLE_SETTINGS':
      return { ...state, settingsOpen: !state.settingsOpen };

    case 'TOGGLE_MISSION_CONTROL':
      return { ...state, missionControlMode: !state.missionControlMode };

    case 'START_CHAT': {
      // Stamp the session being left so model output produced while it was
      // open doesn't surface as an unread badge after starting a new chat.
      const sessionLastSeen = { ...state.sessionLastSeen };
      if (state.activeAppSessionId && state.sessions[state.activeAppSessionId]) {
        sessionLastSeen[state.activeAppSessionId] = Date.now();
      }
      const next = invalidateSelectedChildOpening(state);
      return {
        ...next,
        draftChat: { cwd: action.cwd, branch: action.branch },
        draftAutonomy: null,
        activeAppSessionId: null,
        missionControlMode: false,
        selectedChild: null,
        // Leaving for a fresh draft orphans any pending review-focus request.
        reviewFocusPath: null,
        sessionLastSeen,
      };
    }

    case 'SEED_COMPOSER':
      return { ...state, composerSeed: { text: action.text, id: Date.now() } };

    // The composer consumes the seed once; it must not linger, or remounting
    // the composer (e.g. toggling Mission Control) would re-apply stale text.
    case 'CLEAR_COMPOSER_SEED':
      return { ...state, composerSeed: null };

    case 'SESSION_NOTE_ADD': {
      const sessionNotes = addSessionNote(state.sessionNotes, action.appSessionId, action.text);
      // Blank notes are rejected by the helper; nothing changed.
      if (!sessionNotes) return state;
      return { ...state, sessionNotes };
    }

    case 'SESSION_NOTE_MARK_USED': {
      const sessionNotes = markSessionNoteUsed(
        state.sessionNotes,
        action.appSessionId,
        action.noteId,
      );
      // Already marked or unknown note; nothing changed.
      if (!sessionNotes) return state;
      return { ...state, sessionNotes };
    }

    case 'SESSION_NOTE_REMOVE':
      return {
        ...state,
        sessionNotes: removeSessionNote(state.sessionNotes, action.appSessionId, action.noteId),
      };

    case 'ADD_WORKSPACE':
      return {
        ...state,
        workspaceCwds: saveWorkspaceCwds(addWorkspaceCwd(state.workspaceCwds, action.cwd)),
      };

    case 'TOGGLE_BROWSER': {
      const key = activeBrowserKey(state);
      if (!key) return state;
      const current = utilityPanelForSession(state.utilityPanels, key);
      const existing = current.tabs.find((tab) => tab.tool === 'browser');
      const opening = !existing || !current.open || current.activeTabId !== existing.id;
      return {
        ...state,
        rightPanelOpen: opening ? false : state.rightPanelOpen,
        utilityPanels: {
          ...state.utilityPanels,
          [key]: opening
            ? openUtilityTool(current, 'browser', () => `browser:${key}`)
            : setUtilityPanelOpen(current, false),
        },
        browserOpenKeys: withBrowserOpenKey(state.browserOpenKeys, key, opening),
      };
    }

    case 'SET_BROWSER_OPEN': {
      const key = activeBrowserKey(state);
      if (!key) return state;
      return {
        ...state,
        rightPanelOpen: action.open ? false : state.rightPanelOpen,
        utilityPanels: {
          ...state.utilityPanels,
          [key]: action.open
            ? openUtilityTool(state.utilityPanels[key], 'browser', () => `browser:${key}`)
            : removeUtilityTool(state.utilityPanels[key], 'browser'),
        },
        browserOpenKeys: withBrowserOpenKey(state.browserOpenKeys, key, action.open),
      };
    }

    case 'BROWSER_UPDATED': {
      if (!action.browser.appSessionId) return state;
      const appSessionId = action.browser.appSessionId;
      // Surface a freshly opened browser, but never re-open a pane the user hid.
      // Missing keys differ from explicitly hidden panes.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
      const hidden = state.browserOpenKeys[appSessionId] === false;
      return {
        ...state,
        browsers: { ...state.browsers, [appSessionId]: action.browser },
        browserErrors: Object.fromEntries(
          Object.entries(state.browserErrors).filter(([id]) => id !== appSessionId),
        ),
        browserOpenKeys: hidden
          ? state.browserOpenKeys
          : withBrowserOpenKey(state.browserOpenKeys, appSessionId, true),
        utilityPanels: hidden
          ? state.utilityPanels
          : {
              ...state.utilityPanels,
              [appSessionId]: openUtilityTool(
                state.utilityPanels[appSessionId],
                'browser',
                () => `browser:${appSessionId}`,
              ),
            },
      };
    }

    case 'BROWSER_NAVIGATED': {
      const browser = state.browsers[action.appSessionId];
      // Keep the existence guard because the update below dereferences browser.
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
      if (!browser || browser.browserSessionId !== action.browserSessionId) return state;
      return {
        ...state,
        browsers: {
          ...state.browsers,
          [action.appSessionId]: {
            ...browser,
            url: action.url,
            canGoBack: action.canGoBack ?? browser.canGoBack,
            canGoForward: action.canGoForward ?? browser.canGoForward,
          },
        },
      };
    }

    case 'BROWSER_CLOSED':
      // Full close: drop the session's browser, design mode, and open flag so a
      // later reopen starts fresh (and it is excluded from persistence).
      return {
        ...state,
        browsers: Object.fromEntries(
          Object.entries(state.browsers).filter(([id]) => id !== action.appSessionId),
        ),
        browserErrors: Object.fromEntries(
          Object.entries(state.browserErrors).filter(([id]) => id !== action.appSessionId),
        ),
        designModes: clearDesignMode(state.designModes, action.appSessionId),
        browserOpenKeys: clearBrowserOpenKey(state.browserOpenKeys, action.appSessionId),
        utilityPanels: {
          ...state.utilityPanels,
          [action.appSessionId]: removeUtilityTool(
            state.utilityPanels[action.appSessionId],
            'browser',
          ),
        },
      };

    case 'BROWSER_ERROR':
      if (!action.appSessionId) return { ...state, browserGlobalError: action.message };
      return {
        ...state,
        browserErrors: { ...state.browserErrors, [action.appSessionId]: action.message },
        // Respect an explicit hide; otherwise surface the errored browser.
        browserOpenKeys:
          // Missing keys differ from explicitly hidden panes.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
          state.browserOpenKeys[action.appSessionId] === false
            ? state.browserOpenKeys
            : withBrowserOpenKey(state.browserOpenKeys, action.appSessionId, true),
      };

    case 'TOGGLE_DESIGN_MODE':
      return {
        ...state,
        designModes: toggleDesignMode(state.designModes, action.appSessionId),
      };

    case 'SET_DESIGN_MODE':
      return {
        ...state,
        designModes: setDesignMode(state.designModes, action.appSessionId, action.open),
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

    case 'SELECT_CHILD': {
      const previous = state.selectedChild;
      let next =
        previous &&
        (action.selection?.parentAppSessionId !== previous.parentAppSessionId ||
          action.selection.childSessionId !== previous.childSessionId)
          ? invalidateSelectedChildOpening(state)
          : state;
      if (!action.selection) return { ...next, selectedChild: null };
      const { parentAppSessionId, childSessionId } = action.selection;
      if (
        next.activeAppSessionId !== parentAppSessionId ||
        !next.childSessions[parentAppSessionId]?.[childSessionId]
      )
        return { ...next, selectedChild: null };
      next = { ...next, selectedChild: action.selection };
      if (action.requestId)
        return withChildAccess(next, parentAppSessionId, childSessionId, {
          state: 'opening',
          requestId: action.requestId,
        });
      const access = next.childAccess[parentAppSessionId]?.[childSessionId];
      return access?.state === 'failed' || access?.state === 'closed'
        ? withoutChildAccess(next, parentAppSessionId, childSessionId)
        : next;
    }

    case 'MODELS_LIST':
      return {
        ...state,
        models: action.models,
        agentConfig: saveAgentConfig(sanitizeAgentConfig(state.agentConfig, action.models)),
      };

    case 'SKILLS_LIST':
      return { ...state, skills: action.skills, skillsProviderSessionId: action.providerSessionId };

    case 'FACTORY_DEFAULTS': {
      const next = sanitizeAgentConfig(
        {
          primary: {
            modelId: state.agentConfig.primary.modelId ?? action.defaults.modelId,
            reasoning: state.agentConfig.primary.modelId
              ? state.agentConfig.primary.reasoning
              : (action.defaults.reasoningEffort ?? state.agentConfig.primary.reasoning),
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
        compactionSettingsRev: state.compactionSettingsRev + 1,
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

    case 'SESSION_SET_MODEL': {
      const m = state.sessions[action.appSessionId];
      if (!m) return state;
      const prevOverride = state.sessionSettingOverrides[action.appSessionId] ?? {};
      return {
        ...state,
        sessions: { ...state.sessions, [action.appSessionId]: { ...m, modelId: action.modelId } },
        sessionSettingOverrides: {
          ...state.sessionSettingOverrides,
          [action.appSessionId]: { ...prevOverride, modelId: action.modelId },
        },
      };
    }

    case 'SESSION_SET_REASONING': {
      const m = state.sessions[action.appSessionId];
      if (!m) return state;
      const prevOverride = state.sessionSettingOverrides[action.appSessionId] ?? {};
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.appSessionId]: { ...m, reasoningEffort: action.reasoning },
        },
        sessionSettingOverrides: {
          ...state.sessionSettingOverrides,
          [action.appSessionId]: { ...prevOverride, reasoningEffort: action.reasoning },
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
      return {
        ...state,
        compactionTokenLimit: limit,
        compactionSettingsRev: state.compactionSettingsRev + 1,
      };
    }

    case 'SET_COMPACTION_TOKEN_LIMIT_FOR_MODEL': {
      const limit = normalizeTokenLimit(action.limit);
      const next = { ...state.compactionTokenLimitPerModel };
      if (limit === undefined) delete next[action.modelId];
      else next[action.modelId] = limit;
      saveCompactionTokenLimitPerModel(next);
      return {
        ...state,
        compactionTokenLimitPerModel: next,
        compactionSettingsRev: state.compactionSettingsRev + 1,
      };
    }

    case 'SET_LIVE_ENTER_BEHAVIOR': {
      const behavior = saveLiveEnterBehavior(action.behavior);
      return { ...state, liveEnterBehavior: behavior };
    }

    case 'SET_IMAGE_PASTE_QUALITY': {
      const quality = saveImagePasteQuality(action.quality);
      return { ...state, imagePasteQuality: quality };
    }

    case 'SET_DEFAULT_AUTONOMY': {
      saveDefaultAutonomy(action.autonomy);
      return { ...state, defaultAutonomy: action.autonomy };
    }

    case 'SET_DRAFT_AUTONOMY':
      return { ...state, draftAutonomy: action.autonomy };

    case 'AUTONOMY_UPDATE_REQUESTED':
      return {
        ...state,
        pendingAutonomy: { ...state.pendingAutonomy, [action.appSessionId]: action.autonomy },
      };

    case 'AUTONOMY_UPDATE_SETTLED': {
      if (!(action.appSessionId in state.pendingAutonomy)) return state;
      return {
        ...state,
        pendingAutonomy: Object.fromEntries(
          Object.entries(state.pendingAutonomy).filter(([id]) => id !== action.appSessionId),
        ),
      };
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
  if (typeof browser.browserSessionId !== 'string' || !browser.browserSessionId) return undefined;
  if (typeof browser.url !== 'string' || !browser.url) return undefined;
  const viewport = sanitizeBrowserViewport(browser.viewport);
  if (!viewport) return undefined;
  return {
    browserSessionId: browser.browserSessionId,
    appSessionId:
      typeof browser.appSessionId === 'string' && browser.appSessionId ? browser.appSessionId : key,
    url: browser.url,
    title: typeof browser.title === 'string' ? browser.title : undefined,
    viewport,
    viewportMode: sanitizeBrowserViewportMode(browser.viewportMode),
    scroll: sanitizeBrowserScroll(browser.scroll),
    refs: [],
    ...(browser.canGoBack === true ? { canGoBack: true } : {}),
    ...(browser.canGoForward === true ? { canGoForward: true } : {}),
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
export function toastMessageForEvent(ev: ServerEvent): string | undefined {
  if (
    ev.type === 'error' &&
    (ev.code === 'session.autonomy_update_failed' || ev.code === 'session.create_failed')
  ) {
    return ev.message;
  }
  return ev.type === 'child.error' && ev.operation !== 'open' ? ev.message : undefined;
}

export function adaptEvent(ev: ServerEvent): Action | null {
  switch (ev.type) {
    case 'connection':
      return {
        type: 'SET_CONNECTION',
        status: ev.status === 'connected' ? 'connected' : 'error',
        message: ev.message,
      };
    case 'session.created':
      return { type: 'SESSION_CREATED', clientRef: ev.clientRef, session: ev.session };
    case 'session.updated':
      return { type: 'SESSION_UPDATED', session: ev.session };
    case 'session.closed':
      return { type: 'SESSION_CLOSED', appSessionId: ev.appSessionId };
    case 'mission.features':
      return { type: 'SESSION_FEATURES', appSessionId: ev.appSessionId, features: ev.features };
    case 'mission.progress':
      return { type: 'SESSION_PROGRESS', appSessionId: ev.appSessionId, entries: ev.entries };
    case 'session.child':
      return {
        type: 'SESSION_CHILD',
        child: ev.child,
        runtimeAvailable: ev.runtimeAvailable,
        runtimeGeneration: ev.runtimeGeneration,
      };
    case 'child.updated':
      return ev.access === 'ready'
        ? {
            type: 'CHILD_UPDATED',
            parentAppSessionId: ev.parentAppSessionId,
            childSessionId: ev.childSessionId,
            requestId: ev.requestId,
            access: 'ready',
            runtimeGeneration: ev.runtimeGeneration,
          }
        : {
            type: 'CHILD_UPDATED',
            parentAppSessionId: ev.parentAppSessionId,
            childSessionId: ev.childSessionId,
            requestId: ev.requestId,
            access: 'history',
          };
    case 'child.error':
      return {
        type: 'CHILD_ERROR',
        parentAppSessionId: ev.parentAppSessionId,
        childSessionId: ev.childSessionId,
        requestId: ev.requestId,
        operation: ev.operation,
        message: ev.message,
      };
    case 'event.appended':
      return { type: 'SESSION_TRANSCRIPT', event: ev.event };
    case 'approval.requested':
      return { type: 'SESSION_PERMISSION', request: ev.request };
    case 'question.requested':
      return { type: 'SESSION_QUESTION', question: ev.question };
    case 'error':
      // A failed autonomy change is recoverable: the session keeps its last
      // confirmed level, the pending state settles, and the toast carries the
      // message (see toastMessageForEvent).
      if (ev.code === 'session.autonomy_update_failed') {
        return ev.appSessionId
          ? { type: 'AUTONOMY_UPDATE_SETTLED', appSessionId: ev.appSessionId }
          : null;
      }
      if (ev.code === 'session.create_failed' && ev.clientRef) {
        return {
          type: 'SESSION_CREATE_FAILED',
          clientRef: ev.clientRef,
          message: ev.message,
        };
      }
      if (ev.recoverable) return null;
      if (ev.appSessionId) {
        return {
          type: 'SESSION_ERROR',
          appSessionId: ev.appSessionId,
          providerSessionId: ev.providerSessionId,
          message: ev.message,
        };
      }
      return { type: 'SESSION_ERROR', message: ev.message };
    case 'sessions.list':
      return { type: 'SESSION_LIST', sessions: ev.sessions };
    case 'session.history':
      return {
        type: 'SESSION_HISTORY',
        appSessionId: ev.appSessionId,
        progress: ev.progress,
        transcripts: ev.transcripts,
        childSessions: ev.childSessions,
        mode: ev.mode,
        olderCursor: ev.olderCursor,
        loadedCount: ev.loadedCount,
        hasMore: ev.hasMore,
      };
    case 'session.history.error':
      return { type: 'SESSION_HISTORY_FAILED', appSessionId: ev.appSessionId, message: ev.message };
    case 'context.updated':
      return {
        type: 'CONTEXT_UPDATED',
        appSessionId: ev.appSessionId,
        sourceSessionId: ev.sourceSessionId,
        ...(ev.parentAppSessionId === undefined
          ? {}
          : { parentAppSessionId: ev.parentAppSessionId }),
        ...(ev.childSessionId === undefined ? {} : { childSessionId: ev.childSessionId }),
        stats: ev.stats,
      };
    case 'catalog.updated':
      if (ev.catalog === 'models') {
        return { type: 'MODELS_LIST', models: ev.items as ModelInfo[] };
      }
      if (ev.catalog === 'skills') {
        const skills = (ev.items as SkillInfo[]).filter(
          (s) => s && typeof s.name === 'string' && s.name.length > 0,
        );
        return {
          type: 'SKILLS_LIST',
          skills,
          providerSessionId: ev.providerSessionId ?? null,
        };
      }
      return null;
    case 'settings.defaults':
      return { type: 'FACTORY_DEFAULTS', defaults: ev.defaults };
    case 'browser.updated':
      return { type: 'BROWSER_UPDATED', browser: ev.state };
    case 'browser.closed':
      return { type: 'BROWSER_CLOSED', appSessionId: ev.appSessionId };
    case 'browser.error':
      return { type: 'BROWSER_ERROR', appSessionId: ev.appSessionId, message: ev.message };
    default:
      return null;
  }
}

// Exported so tests can mount a component against a reducer-built state
// without standing up the full provider side effects (persistence, bridge).
export const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, syncBrowserOpen);

  useEffect(() => {
    savePersistedUiState(state);
    saveSessionLastSeen(state.sessionLastSeen);
    saveSessionNotes(state.sessionNotes);
  }, [
    state.sessionLastSeen,
    state.sessionNotes,
    state.activeAppSessionId,
    state.browserOpenKeys,
    state.browsers,
    state.missionControlMode,
    state.rightPanelOpen,
    state.utilityPanels,
    state.selectedChild,
    state.selectedFeatureId,
    state.sidebarCollapsed,
    state.specMode,
  ]);

  // Keep the sidecar's compaction-limit snapshot in sync so live sessions,
  // resumes, and model changes all follow these limits. The bridge queues
  // commands until the socket opens, so the mount-time push is safe. Keyed on
  // the settings revision rather than the values: a clear can leave the values
  // structurally identical (undefined -> undefined) while the user-configured
  // markers changed, and that must still reach the sidecar.
  useEffect(() => {
    updateCompactionSettings(compactionSettingsSnapshot(state));
  }, [state.compactionSettingsRev]);

  // Persist the reload snapshot only when the session list or the active
  // transcript actually changed (references are immutable), debounced so
  // streaming bursts coalesce into one write. The scheduler owns its timer,
  // so an unrelated state change can never cancel a pending write, and the
  // effect depends on the derived active transcript so background sessions'
  // transcript updates do not retrigger it.
  const [snapshotScheduler] = useState(() => createSnapshotScheduler(400));
  const activeTranscriptEvents = state.activeAppSessionId
    ? state.transcripts[state.activeAppSessionId]
    : undefined;
  useEffect(() => {
    const activeId = state.activeAppSessionId;
    snapshotScheduler.push({
      sessions: state.sessions,
      sessionOrder: state.sessionOrder,
      activeTranscript:
        activeId !== null && activeTranscriptEvents !== undefined
          ? { appSessionId: activeId, events: activeTranscriptEvents }
          : undefined,
    });
  }, [
    snapshotScheduler,
    state.sessions,
    state.sessionOrder,
    state.activeAppSessionId,
    activeTranscriptEvents,
  ]);
  useEffect(
    () => () => {
      snapshotScheduler.cancel();
    },
    [snapshotScheduler],
  );

  useEffect(() => {
    const unsub = bridge.subscribe((ev) => {
      // Verbose per-event logging runs on every streaming token and eagerly
      // deep-clones + redacts the whole event, so keep it to dev builds only;
      // production strips this branch entirely.
      if (import.meta.env.DEV) console.log('[bridge]', ev.type, sanitizeForLog(ev));
      const toastMessage = toastMessageForEvent(ev);
      if (toastMessage !== undefined) toast.error(toastMessage);
      const action = adaptEvent(ev);
      if (action) dispatch(action);
    });
    return () => {
      unsub();
    };
  }, []);

  // Memoize the context value so a StoreProvider re-render with unchanged
  // state (parent re-render, StrictMode double-render) doesn't hand consumers
  // a fresh { state, dispatch } identity. Dispatches still re-render every
  // consumer, since the reducer returns a new state object; this only removes
  // the same-state case. dispatch is stable from useReducer, so [state] is the
  // correct key.
  const value = useMemo(() => ({ state, dispatch }), [state]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used within StoreProvider');
  return context;
}
