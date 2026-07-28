// Bridge protocol shared between the Node sidecar and the React frontend.
// The frontend keeps a mirror copy at src/types/bridge.ts — keep them in sync.

export type SessionPhase =
  | 'intake'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'awaiting_run_start'
  | 'initializing'
  | 'running'
  | 'orchestrator_turn'
  | 'paused'
  | 'completed'
  | 'failed';

export type FeatureStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type SessionRole = 'primary' | 'worker' | 'validator';
export type SessionPurpose = 'chat' | 'design' | 'mission-control';
export type SessionInteractionMode = 'auto' | 'spec' | 'agi';
export type RunStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'blocked';
export type Autonomy = 'off' | 'low' | 'medium' | 'high';
export type ReasoningEffort =
  | 'off'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'dynamic';

export interface BridgeFeature {
  id: string;
  description: string;
  status: FeatureStatus;
  skillName: string;
  preconditions: string[];
  expectedBehavior: string[];
  verificationSteps: string[];
  fulfills?: string[];
  milestone?: string;
  workerProviderSessionIds?: string[];
  currentWorkerProviderSessionId?: string | null;
  completedWorkerProviderSessionId?: string | null;
}

export interface ProgressEntry {
  type: string;
  timestamp: string;
  title?: string;
  message?: string;
  featureId?: string;
  workerProviderSessionId?: string;
}

export interface ChildSessionSummary {
  providerSessionId: string;
  status: 'running' | 'paused' | 'completed';
  label?: string;
  prompt?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  // The primary session's Task tool_call id that spawned this child session;
  // links an in-chat spawn line to its transcript.
  toolUseId?: string;
}

// The exact toolUseId -> providerSessionId mapping persisted for a parent session, so
// historical loads can rebuild precise child session links instead of guessing.
export interface ChildSessionHistoryLink {
  providerSessionId: string;
  toolUseId?: string;
  label?: string;
  // Live run state for the linked worker, set only when the parent session is still
  // active so a reconnect/reload doesn't render a running child session as finished.
  // Omitted (treated as completed) for historical loads.
  status?: 'running' | 'paused' | 'completed';
}

export interface SessionSummary {
  appSessionId: string;
  providerSessionId?: string;
  compactedFromProviderSessionIds?: string[];
  missionId?: string;
  parentProviderSessionId?: string;
  sessionPurpose: SessionPurpose;
  interactionMode: SessionInteractionMode;
  role: SessionRole | 'user';
  title: string;
  goal: string;
  cwd: string;
  workspaceKind?: 'folder' | 'none';
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  compactionModel?: string;
  workerModelId?: string;
  workerReasoningEffort?: ReasoningEffort;
  validatorModelId?: string;
  validatorReasoningEffort?: ReasoningEffort;
  autonomy: Autonomy;
  phase: SessionPhase;
  streaming?: boolean; // true while a turn is actively generating
  queuedSends?: number;
  proposal?: string; // markdown plan from propose_mission
  features: BridgeFeature[];
  tokensIn: number;
  tokensOut: number;
  contextTokens: number;
  contextRemainingTokens?: number;
  contextAccuracy?: 'exact' | 'estimated';
  contextUpdatedAt?: string;
  maxContextTokens?: number;
  // The auto-compaction trigger the sidecar last armed on the daemon for this
  // session (already clamped below the model window), cleared when arming
  // failed. Recorded as diagnostic/persisted truth; the meter itself renders
  // the context window only and compaction announces itself in the transcript.
  compactionTokenLimit?: number;
  // In-place daemon auto-compactions completed on this session; the UI uses it
  // (plus the swap chain length) as the compaction generation for meter resets.
  autoCompactions?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TranscriptEvent {
  id: string;
  appSessionId: string;
  sourceSessionId: string;
  role: SessionRole;
  ts: number;
  // Monotonic canonical order for primary-session scrollback, stamped during
  // replay from the compaction-chain position. Survives equal `ts` collisions
  // so restored history never reorders. Live events omit it (they are newest).
  seq?: number;
  endTs?: number;
  kind: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'status' | 'compaction';
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolUseId?: string;
  isError?: boolean;
  // For a 'compaction' divider: how many messages the compaction summarized away.
  removedCount?: number;
  author?: 'user';
  // Frontend display metadata for user-authored prompt chips.
  skills?: string[];
  files?: string[];
  browserRefs?: BrowserTranscriptReference[];
  steered?: boolean;
  compactType?: 'auto' | 'manual';
}

export type BrowserTranscriptReferenceKind = 'element' | 'region' | 'text';

export interface BrowserTranscriptReference {
  id: string;
  label: string;
  kind: BrowserTranscriptReferenceKind;
  url?: string;
  selector?: string;
  imageDataUrl?: string;
}

export type PermissionKind =
  | 'edit'
  | 'exec'
  | 'create'
  | 'apply_patch'
  | 'mcp'
  | 'spec'
  | 'mission_plan'
  | 'other';
export type ConfigurableSessionRole = 'primary' | 'worker' | 'validator';

export interface PermissionRequest {
  appSessionId: string;
  requestId: string;
  kind: PermissionKind;
  title: string;
  detail: string; // human readable (command, file path, diff snippet)
  plan?: string; // full plan/spec body (exit_spec_mode)
  options?: string[]; // custom option names offered by the tool
  raw: unknown;
}

export interface SessionQuestion {
  appSessionId: string;
  requestId: string;
  questions: { index: number; question: string; options: string[] }[];
}

export type SkillLocation = 'project' | 'personal' | 'builtin';

export interface SkillInfo {
  name: string;
  description?: string;
  location: SkillLocation;
  filePath: string;
  enabled?: boolean;
  userInvocable?: boolean;
  version?: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider?: string;
  isCustom: boolean;
  isDefault?: boolean;
  maxContextTokens?: number;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export interface FactoryDefaultSettings {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  compactionModel?: string;
  compactionTokenLimit?: number;
  compactionTokenLimitPerModel?: Record<string, number>;
  autonomy?: Autonomy;
  interactionMode?: SessionInteractionMode;
  specModelId?: string;
  specReasoningEffort?: ReasoningEffort;
  missionOrchestratorModelId?: string;
  missionOrchestratorReasoningEffort?: ReasoningEffort;
  workerModelId?: string;
  workerReasoningEffort?: ReasoningEffort;
  validatorModelId?: string;
  validatorReasoningEffort?: ReasoningEffort;
}

export type InstallChannel = 'script' | 'brew' | 'npm';

export interface PackageManagers {
  brew: boolean;
  npm: boolean;
  curl: boolean;
  pnpm: boolean;
}

export interface CliInfo {
  present: boolean;
  path: string;
  version?: string;
}

export interface EnvironmentReport {
  platform: NodeJS.Platform;
  arch: string;
  osVersion: string;
  node: { present: boolean; version?: string };
  cli: CliInfo;
  packageManagers: PackageManagers;
  auth: { apiKeyConfigured: boolean; loginPresent: boolean };
  availableChannels: InstallChannel[];
}

export interface ContextStatsSnapshot {
  used: number;
  remaining: number;
  limit: number;
  accuracy: 'exact' | 'estimated';
  updatedAt: string;
  breakdown?: ContextBreakdownSnapshot;
  // In-place compactions completed on this agent session; set for worker
  // snapshots (parent sessions carry their generation on the summary instead).
  compactions?: number;
}

export interface ContextBreakdownCategory {
  name: string;
  tokens: number;
  colorKey?: string;
}

export interface ContextBreakdownSnapshot {
  modelId?: string;
  modelDisplayName?: string;
  contextBudget: number;
  usedTokens: number;
  freeTokens: number;
  categories: ContextBreakdownCategory[];
}

export interface SessionHistoryEntry {
  providerSessionId: string;
  title: string;
  cwd?: string;
  modifiedTime: number;
  createdTime: number;
  messageCount: number;
}

export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export type BrowserViewportMode = 'fit' | 'desktop' | 'laptop' | 'tablet' | 'mobile' | 'custom';
export type BrowserScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface BrowserBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserElementRef {
  ref: string;
  selector: string;
  tagName: string;
  role?: string;
  name?: string;
  text?: string;
  attributes?: Record<string, string>;
  className?: string;
  box: BrowserBox;
  computedStyles?: Record<string, string>;
}

export interface BrowserState {
  browserSessionId: string;
  appSessionId?: string;
  url: string;
  title?: string;
  viewport: BrowserViewport;
  viewportMode: BrowserViewportMode;
  screenshotPath?: string;
  screenshotUrl?: string;
  scroll: { x: number; y: number };
  refs: BrowserElementRef[];
  canGoBack?: boolean;
  canGoForward?: boolean;
  agentCursor?: { x: number; y: number };
  error?: string;
}

export interface BrowserNativeSnapshot {
  url: string;
  title?: string;
  scroll: { x: number; y: number };
  refs: BrowserElementRef[];
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface BrowserElementInspection {
  selector: string;
  tagName: string;
  role?: string;
  name?: string;
  text?: string;
  attributes: Record<string, string>;
  box: BrowserBox;
  html: string;
  iframe?: {
    src?: string;
    accessible: boolean;
  };
}

export interface BrowserNetworkEvent {
  timestamp: number;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  error?: string;
}

export interface BrowserConsoleEvent {
  timestamp: number;
  level: number;
  message: string;
  line?: number;
  source?: string;
}

export type BrowserNativeAction =
  | 'open'
  | 'reload'
  | 'goBack'
  | 'goForward'
  | 'snapshot'
  | 'click'
  | 'hover'
  | 'selectOption'
  | 'type'
  | 'keypress'
  | 'scroll'
  | 'resize'
  | 'inspect'
  | 'network'
  | 'console'
  | 'capture'
  | 'close'
  | 'fillCredentials';

export interface BrowserNativeRequest {
  requestId: string;
  appSessionId: string;
  browserSessionId: string;
  action: BrowserNativeAction;
  url?: string;
  viewport?: BrowserViewport;
  viewportMode?: BrowserViewportMode;
  x?: number;
  y?: number;
  selector?: string;
  text?: string;
  key?: string;
  direction?: BrowserScrollDirection;
  pixels?: number;
  box?: BrowserBox;
  fullPage?: boolean;
  deviceScaleFactor?: number;
  clearNetworkLog?: boolean;
  clearConsoleLog?: boolean;
}

export interface BrowserNativeResult {
  requestId: string;
  appSessionId: string;
  browserSessionId: string;
  ok: boolean;
  snapshot?: BrowserNativeSnapshot;
  inspection?: BrowserElementInspection;
  networkEvents?: BrowserNetworkEvent[];
  consoleEvents?: BrowserConsoleEvent[];
  image?: string;
  error?: string;
}

export interface ElementSource {
  framework?: 'react' | 'vue' | 'svelte' | 'unknown';
  component?: string;
  componentChain?: string[];
  file?: string;
  line?: number;
  column?: number;
  confidence: 'exact' | 'attribute' | 'heuristic' | 'none';
}

export interface DesignAnchorAncestor {
  tag: string;
  component?: string;
  selector?: string;
}

export interface DesignStrokePoint {
  x: number;
  y: number;
}

export interface DesignSelectionScreenshot {
  base64: string;
  box: BrowserBox;
}

export interface DesignAnchor {
  id: string;
  kind: 'element' | 'region' | 'text';
  label: string;
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  box: BrowserBox;
  source?: ElementSource;
  screenshotPath?: string;
  strokes?: DesignStrokePoint[][];
}

export interface DesignAnchorDetail {
  id: string;
  selector: string;
  selectorVerified: boolean;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  ancestors: DesignAnchorAncestor[];
  html?: string;
}

export interface DesignReference {
  id: string;
  anchor: DesignAnchor;
  detail?: DesignAnchorDetail;
  url: string;
  title?: string;
  viewport?: BrowserViewport;
  scroll?: { x: number; y: number };
  screenshot?: DesignSelectionScreenshot;
  createdAt?: string;
}

export type PermissionOutcome =
  | 'proceed_once'
  | 'proceed_always'
  | 'proceed_auto_run'
  | 'proceed_auto_run_low'
  | 'proceed_auto_run_medium'
  | 'proceed_auto_run_high'
  | 'proceed_new_session'
  | 'proceed_new_session_low'
  | 'proceed_new_session_medium'
  | 'proceed_new_session_high'
  | 'proceed_edit'
  | 'cancel';

// ── Frontend -> Sidecar ──────────────────────────────────────────────
export type ClientCommand =
  | { type: 'connect'; apiKey?: string }
  | { type: 'runtime.status' }
  | { type: 'auth.status' }
  | { type: 'auth.startCliLogin' }
  | { type: 'env.detect' }
  | { type: 'cli.install'; channel: InstallChannel }
  | { type: 'cli.update'; channel?: InstallChannel }
  | { type: 'catalog.models' }
  | { type: 'catalog.tools'; providerSessionId?: string }
  | { type: 'catalog.skills'; providerSessionId?: string }
  | { type: 'catalog.mcp'; providerSessionId?: string }
  | { type: 'settings.defaults' }
  | {
      type: 'session.create';
      clientRef: string;
      cwd?: string;
      title: string;
      goal: string;
      sessionPurpose: SessionPurpose;
      interactionMode?: SessionInteractionMode;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
      compactionModel?: string;
      compactionTokenLimit?: number | null;
      compactionTokenLimitPerModel?: Record<string, number>;
      autonomy?: Autonomy;
      workerModel?: string;
      workerReasoning?: ReasoningEffort;
      validatorModel?: string;
      validatorReasoning?: ReasoningEffort;
    }
  | { type: 'session.send'; appSessionId: string; text: string }
  | { type: 'session.sendNow'; appSessionId: string; text: string }
  | { type: 'session.resume'; appSessionId: string }
  | { type: 'session.interrupt'; appSessionId: string }
  | {
      type: 'session.updateSettings';
      appSessionId: string;
      modelId?: string | null;
      reasoningEffort?: ReasoningEffort;
      autonomy?: Autonomy;
      interactionMode?: SessionInteractionMode;
    }
  | { type: 'session.compact'; appSessionId: string; customInstructions?: string }
  | { type: 'session.fork'; appSessionId: string }
  | { type: 'session.rename'; appSessionId: string; title: string }
  | { type: 'session.rewindInfo'; appSessionId: string }
  | { type: 'session.rewind'; appSessionId: string; rewindId?: string }
  | { type: 'session.close'; appSessionId: string }
  | {
      type: 'sessions.list';
      workspaceCwds?: string[];
      includePlainChats?: boolean;
      limitPerWorkspace?: number;
    }
  | { type: 'session.loadHistory'; appSessionId: string; cursor?: string }
  | { type: 'child.open'; appSessionId: string; providerSessionId: string; role?: SessionRole }
  | { type: 'child.send'; appSessionId: string; providerSessionId: string; text: string }
  | { type: 'child.sendNow'; appSessionId: string; providerSessionId: string; text: string }
  | { type: 'child.interrupt'; appSessionId: string; providerSessionId: string }
  | {
      type: 'child.updateSettings';
      parentAppSessionId: string;
      childSessionId: string;
      modelId: string | null;
      reasoningEffort?: ReasoningEffort;
    }
  | {
      type: 'approval.respond';
      appSessionId: string;
      requestId: string;
      outcome: PermissionOutcome;
    }
  | {
      type: 'question.respond';
      appSessionId: string;
      requestId: string;
      cancelled: boolean;
      answers: { index: number; question: string; answer: string }[];
    }
  | { type: 'history.list' }
  | { type: 'history.page'; providerSessionId: string; cursor?: string; limit?: number }
  | {
      type: 'settings.agent.update';
      appSessionId?: string;
      agent: ConfigurableSessionRole;
      modelId?: string | null;
      reasoningEffort?: ReasoningEffort;
    }
  | {
      // Snapshot of the app's explicitly configured compaction limits. A null
      // global or empty per-model map means the user cleared that tier; omitted
      // fields continue following CLI-file defaults.
      type: 'settings.compaction.update';
      compactionTokenLimit?: number | null;
      compactionTokenLimitPerModel?: Record<string, number>;
    }
  | {
      type: 'browser.open';
      appSessionId: string;
      url: string;
      viewport?: BrowserViewport;
      viewportMode?: BrowserViewportMode;
    }
  | { type: 'browser.close'; appSessionId: string }
  | { type: 'browser.reload'; appSessionId: string }
  | { type: 'browser.refresh'; appSessionId: string }
  | {
      type: 'browser.resizeViewport';
      appSessionId: string;
      viewport: BrowserViewport;
      viewportMode: BrowserViewportMode;
    }
  | {
      type: 'browser.click';
      appSessionId: string;
      ref?: string;
      x?: number;
      y?: number;
      source?: 'agent' | 'user';
    }
  | { type: 'browser.type'; appSessionId: string; text: string }
  | { type: 'browser.keypress'; appSessionId: string; key: string }
  | {
      type: 'browser.scroll';
      appSessionId: string;
      direction: BrowserScrollDirection;
      pixels?: number;
      ref?: string;
      source?: 'agent' | 'user';
    }
  | {
      type: 'browser.screenshot';
      appSessionId: string;
      fullPage?: boolean;
      deviceScaleFactor?: number;
    }
  | { type: 'browser.inspectPoint'; appSessionId: string; x: number; y: number }
  | { type: 'browser.design.addReference'; appSessionId: string; reference: DesignReference }
  | {
      type: 'browser.design.sendPrompt';
      appSessionId: string;
      instruction: string;
      referenceIds: string[];
    }
  | { type: 'browser.native.result'; result: BrowserNativeResult }
  | { type: 'spec.read'; appSessionId: string; path: string };

export type ChildUpdatedEvent =
  | {
      type: 'child.updated';
      appSessionId: string;
      providerSessionId: string;
      role: SessionRole;
      status: 'opened' | 'running' | 'paused' | 'completed';
    }
  | {
      type: 'child.updated';
      parentAppSessionId: string;
      childSessionId: string;
      role: 'worker' | 'validator';
      status: 'opened';
      settingsReady: true;
    };

export type SessionChildEvent =
  | {
      type: 'session.child';
      appSessionId: string;
      event: 'started' | 'updated' | 'completed';
      providerSessionId: string;
      exitCode?: number;
      label?: string;
      prompt?: string;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
      toolUseId?: string;
    }
  | {
      type: 'session.child';
      parentAppSessionId: string;
      event: 'updated';
      childSessionId: string;
      modelId: string;
      reasoningEffort?: ReasoningEffort;
    };

// ── Sidecar -> Frontend ──────────────────────────────────────────────
export type ServerEvent =
  | { type: 'connection'; status: 'connected' | 'error'; message?: string }
  | {
      type: 'runtime.updated';
      status: { mode: 'cli_auth'; droidPath: string; apiKeyConfigured: boolean };
    }
  | { type: 'env.report'; report: EnvironmentReport }
  | {
      type: 'cli.install.progress';
      phase: 'install' | 'update';
      stream: 'stdout' | 'stderr';
      line: string;
    }
  | { type: 'cli.install.done'; phase: 'install' | 'update'; ok: boolean; exitCode: number }
  | { type: 'session.created'; clientRef: string; session: SessionSummary }
  | { type: 'session.updated'; session: SessionSummary }
  | ChildUpdatedEvent
  | { type: 'event.appended'; event: TranscriptEvent }
  | { type: 'approval.requested'; request: PermissionRequest }
  | { type: 'question.requested'; question: SessionQuestion }
  | {
      type: 'context.updated';
      appSessionId: string;
      sourceSessionId: string;
      stats: ContextStatsSnapshot;
      breakdown?: unknown;
    }
  | {
      type: 'mcp.authRequested';
      providerSessionId: string;
      serverName?: string;
      authUrl?: string;
      message?: string;
    }
  | {
      type: 'catalog.updated';
      catalog: 'models' | 'tools' | 'skills' | 'mcp';
      items: unknown[];
      providerSessionId?: string | null;
    }
  | { type: 'settings.defaults'; defaults: FactoryDefaultSettings }
  | {
      type: 'error';
      code?: string;
      appSessionId?: string;
      providerSessionId?: string;
      parentAppSessionId?: string;
      childSessionId?: string;
      message: string;
      recoverable?: boolean;
    }
  | {
      type: 'child.not_steerable';
      appSessionId: string;
      providerSessionId: string;
      message: string;
    }
  | {
      type: 'mission.features';
      appSessionId: string;
      missionId?: string;
      features: BridgeFeature[];
    }
  | { type: 'mission.progress'; appSessionId: string; missionId?: string; entries: ProgressEntry[] }
  | SessionChildEvent
  | { type: 'spec.content'; appSessionId: string; path: string; content: string }
  | { type: 'sessions.list'; sessions: SessionSummary[] }
  | {
      type: 'session.history';
      appSessionId: string;
      progress: ProgressEntry[];
      transcripts: TranscriptEvent[];
      childSessions?: ChildSessionHistoryLink[];
      mode?: 'replace' | 'prepend';
      olderCursor?: string;
      // Restore telemetry: how many transcript events this page delivered and
      // whether older history remains to page in. Lets the client show an
      // explicit restoring/partial/complete state instead of guessing.
      loadedCount?: number;
      hasMore?: boolean;
    }
  | { type: 'session.history.error'; appSessionId: string; message: string }
  | { type: 'history.list'; sessions: SessionHistoryEntry[] }
  | { type: 'browser.updated'; state: BrowserState }
  | { type: 'browser.native.request'; request: BrowserNativeRequest }
  | { type: 'browser.closed'; appSessionId: string }
  | { type: 'browser.error'; appSessionId?: string; message: string };
