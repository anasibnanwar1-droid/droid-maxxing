// Mirror of sidecar/src/protocol.ts — keep in sync.

export type MissionPhase =
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
export type AgentRole = 'orchestrator' | 'worker' | 'validator';
export type SessionKind = 'chat' | 'spec' | 'mission_orchestrator' | 'mission_worker' | 'mission_validator';
export type SessionInteractionMode = 'auto' | 'spec' | 'agi';
export type Autonomy = 'off' | 'low' | 'medium' | 'high';
export type ReasoningEffort = 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'dynamic';

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
  workerSessionIds?: string[];
  currentWorkerSessionId?: string | null;
  completedWorkerSessionId?: string | null;
}

export interface ProgressEntry {
  type: string;
  timestamp: string;
  title?: string;
  message?: string;
  featureId?: string;
  workerSessionId?: string;
}

export interface WorkerSummary {
  sessionId: string;
  status: 'running' | 'paused' | 'completed';
  label?: string;
  prompt?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
}

export type WorkspaceKind = 'folder' | 'none';

export interface MissionSummary {
  id: string;            // stable app conversation id
  sessionId?: string;    // active Droid session id
  compactedFromSessionIds?: string[];
  missionId?: string;
  parentSessionId?: string;
  kind: SessionKind;
  role: AgentRole | 'user';
  title: string;
  goal: string;
  cwd: string;
  workspaceKind?: WorkspaceKind;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  compactionModel?: string;
  workerModelId?: string;
  workerReasoningEffort?: ReasoningEffort;
  validatorModelId?: string;
  validatorReasoningEffort?: ReasoningEffort;
  autonomy: Autonomy;
  phase: MissionPhase;
  streaming?: boolean;
  queuedSends?: number;
  proposal?: string;
  features: BridgeFeature[];
  tokensIn: number;
  tokensOut: number;
  contextTokens: number;
  contextRemainingTokens?: number;
  contextAccuracy?: 'exact' | 'estimated';
  contextUpdatedAt?: string;
  maxContextTokens?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TranscriptEvent {
  id: string;
  missionId: string;
  agentSessionId: string;
  role: AgentRole;
  ts: number;
  endTs?: number;
  kind: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'status';
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  isError?: boolean;
  author?: 'user';
  // Frontend-only: attachments shown as chips on a user message.
  skills?: string[];
  files?: string[];
  browserRefs?: BrowserTranscriptReference[];
  // Frontend-only: this user message was sent while the model was already working.
  steered?: boolean;
}

export type BrowserTranscriptReferenceKind = 'element' | 'region' | 'text';

export interface BrowserTranscriptReference {
  id: string;
  label: string;
  kind: BrowserTranscriptReferenceKind;
  url?: string;
  selector?: string;
  // Annotated capture shown as a thumbnail on the chat message.
  imageDataUrl?: string;
}

export type PermissionKind = 'edit' | 'exec' | 'create' | 'apply_patch' | 'mcp' | 'spec' | 'mission_plan' | 'other';
export type ConfigurableAgent = 'orchestrator' | 'worker' | 'validator';

export interface PermissionRequest {
  missionId: string;
  requestId: string;
  kind: PermissionKind;
  title: string;
  detail: string;
  plan?: string;
  options?: string[];
  raw: unknown;
}

export interface MissionQuestion {
  missionId: string;
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
  specModelId?: string;
  specReasoningEffort?: ReasoningEffort;
  workerModelId?: string;
  workerReasoningEffort?: ReasoningEffort;
  validatorModelId?: string;
  validatorReasoningEffort?: ReasoningEffort;
}

export interface ContextStatsSnapshot {
  used: number;
  remaining: number;
  limit: number;
  accuracy: 'exact' | 'estimated';
  updatedAt: string;
  breakdown?: ContextBreakdownSnapshot;
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

export interface HistoryMission {
  sessionId: string;
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
  sessionId: string;
  missionId?: string;
  url: string;
  title?: string;
  viewport: BrowserViewport;
  viewportMode: BrowserViewportMode;
  screenshotPath?: string;
  screenshotUrl?: string;
  scroll: { x: number; y: number };
  refs: BrowserElementRef[];
  agentCursor?: { x: number; y: number };
  error?: string;
}

export interface BrowserNativeSnapshot {
  url: string;
  title?: string;
  scroll: { x: number; y: number };
  refs: BrowserElementRef[];
}

export type BrowserNativeAction = 'open' | 'reload' | 'snapshot' | 'click' | 'type' | 'keypress' | 'scroll' | 'capture' | 'close' | 'fillCredentials';

export interface BrowserNativeRequest {
  requestId: string;
  missionId: string;
  sessionId: string;
  action: BrowserNativeAction;
  url?: string;
  viewport?: BrowserViewport;
  viewportMode?: BrowserViewportMode;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  direction?: BrowserScrollDirection;
  pixels?: number;
  box?: BrowserBox;
  fullPage?: boolean;
  deviceScaleFactor?: number;
}

export interface BrowserNativeResult {
  requestId: string;
  missionId: string;
  ok: boolean;
  snapshot?: BrowserNativeSnapshot;
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

// Region capture taken by the Electron main process while in-page
// annotations (pencil strokes, highlights) are still visible.
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

export type ClientCommand =
  | { type: 'connect'; apiKey?: string }
  | { type: 'runtime.status' }
  | { type: 'auth.status' }
  | { type: 'auth.startCliLogin' }
  | { type: 'catalog.models' }
  | { type: 'catalog.tools'; sessionId?: string }
  | { type: 'catalog.skills'; sessionId?: string }
  | { type: 'catalog.mcp'; sessionId?: string }
  | { type: 'settings.defaults' }
  | {
      type: 'mission.create';
      clientRef: string;
      cwd?: string;
      title: string;
      goal: string;
      interactionMode?: SessionInteractionMode;
      modelId?: string;
      reasoningEffort?: ReasoningEffort;
      compactionModel?: string;
      compactionTokenLimit?: number | null;
      compactionTokenLimitPerModel?: Record<string, number>;
      autonomy: Autonomy;
      workerModel?: string;
      workerReasoning?: ReasoningEffort;
      validatorModel?: string;
      validatorReasoning?: ReasoningEffort;
    }
  | { type: 'session.create'; clientRef: string; cwd?: string; title: string; goal: string; interactionMode: SessionInteractionMode; modelId?: string; reasoningEffort?: ReasoningEffort; compactionModel?: string; compactionTokenLimit?: number | null; compactionTokenLimitPerModel?: Record<string, number>; autonomy: Autonomy }
  | { type: 'session.send'; sessionId: string; text: string }
  | { type: 'session.sendNow'; sessionId: string; text: string }
  | { type: 'session.resume'; sessionId: string }
  | { type: 'session.interrupt'; sessionId: string }
  | { type: 'session.updateSettings'; sessionId: string; modelId?: string | null; reasoningEffort?: ReasoningEffort; autonomy?: Autonomy }
  | { type: 'session.compact'; sessionId: string; customInstructions?: string }
  | { type: 'session.fork'; sessionId: string }
  | { type: 'session.rename'; sessionId: string; title: string }
  | { type: 'session.rewindInfo'; sessionId: string }
  | { type: 'session.rewind'; sessionId: string; rewindId?: string }
  | { type: 'agent.open'; missionId: string; agentSessionId: string; role?: AgentRole }
  | { type: 'agent.send'; missionId: string; agentSessionId: string; text: string }
  | { type: 'agent.sendNow'; missionId: string; agentSessionId: string; text: string }
  | { type: 'agent.interrupt'; missionId: string; agentSessionId: string }
  | { type: 'approval.respond'; missionId: string; requestId: string; outcome: PermissionOutcome }
  | { type: 'question.respond'; missionId: string; requestId: string; cancelled: boolean; answers: { index: number; question: string; answer: string }[] }
  | { type: 'history.list' }
  | { type: 'history.page'; sessionId: string; cursor?: string; limit?: number }
  | { type: 'mission.send'; missionId: string; text: string }
  | { type: 'mission.sendNow'; missionId: string; text: string }
  | { type: 'mission.respondPermission'; missionId: string; requestId: string; outcome: PermissionOutcome }
  | { type: 'mission.respondQuestion'; missionId: string; requestId: string; cancelled: boolean; answers: { index: number; question: string; answer: string }[] }
  | { type: 'mission.interrupt'; missionId: string }
  | { type: 'mission.compact'; missionId: string; customInstructions?: string }
  | { type: 'mission.subscribeWorker'; missionId: string; workerSessionId: string }
  | { type: 'mission.close'; missionId: string }
  | { type: 'mission.list'; workspaceCwds?: string[]; includePlainChats?: boolean; limitPerWorkspace?: number }
  | { type: 'mission.loadHistory'; missionId: string }
  | { type: 'settings.agent.update'; missionId?: string; agent: ConfigurableAgent; modelId?: string | null; reasoningEffort?: ReasoningEffort }
  | { type: 'mission.setAutonomy'; missionId: string; autonomy: Autonomy }
  | { type: 'mission.setInteractionMode'; missionId: string; mode: SessionInteractionMode }
  | { type: 'browser.open'; missionId: string; url: string; viewport?: BrowserViewport; viewportMode?: BrowserViewportMode }
  | { type: 'browser.close'; missionId: string }
  | { type: 'browser.reload'; missionId: string }
  | { type: 'browser.refresh'; missionId: string }
  | { type: 'browser.resizeViewport'; missionId: string; viewport: BrowserViewport; viewportMode: BrowserViewportMode }
  | { type: 'browser.click'; missionId: string; ref?: string; x?: number; y?: number; source?: 'agent' | 'user' }
  | { type: 'browser.type'; missionId: string; text: string }
  | { type: 'browser.keypress'; missionId: string; key: string }
  | { type: 'browser.scroll'; missionId: string; direction: BrowserScrollDirection; pixels?: number; source?: 'agent' | 'user' }
  | { type: 'browser.screenshot'; missionId: string; fullPage?: boolean; deviceScaleFactor?: number }
  | { type: 'browser.inspectPoint'; missionId: string; x: number; y: number }
  | { type: 'browser.design.addReference'; missionId: string; reference: DesignReference; screenshot?: DesignSelectionScreenshot }
  | { type: 'browser.design.sendPrompt'; missionId: string; instruction: string; referenceIds: string[] }
  | { type: 'browser.native.result'; result: BrowserNativeResult }
  | { type: 'sessions.list' }
  | { type: 'mission.resume'; sessionId: string }
  | { type: 'models.list' };

export type ServerEvent =
  | { type: 'connection'; status: 'connected' | 'error'; message?: string }
  | { type: 'runtime.updated'; status: { mode: 'cli_auth'; droidPath: string; apiKeyConfigured: boolean } }
  | { type: 'session.updated'; session: MissionSummary }
  | { type: 'agent.updated'; missionId: string; agentSessionId: string; role: AgentRole; status: 'opened' | 'running' | 'paused' | 'completed' }
  | { type: 'event.appended'; event: TranscriptEvent }
  | { type: 'approval.requested'; request: PermissionRequest }
  | { type: 'question.requested'; question: MissionQuestion }
  | { type: 'context.updated'; sessionId: string; stats: ContextStatsSnapshot; breakdown?: unknown }
  | { type: 'mcp.authRequested'; sessionId: string; serverName?: string; authUrl?: string; message?: string }
  | { type: 'catalog.updated'; catalog: 'models' | 'tools' | 'skills' | 'mcp'; items: unknown[]; sessionId?: string | null }
  | { type: 'settings.defaults'; defaults: FactoryDefaultSettings }
  | { type: 'error'; code?: string; sessionId?: string; missionId?: string; message: string }
  | { type: 'agent.not_steerable'; missionId: string; agentSessionId: string; message: string }
  | { type: 'mission.created'; clientRef: string; mission: MissionSummary }
  | { type: 'mission.updated'; mission: MissionSummary }
  | { type: 'mission.features'; missionId: string; features: BridgeFeature[] }
  | { type: 'mission.progress'; missionId: string; entries: ProgressEntry[] }
  | { type: 'mission.worker'; missionId: string; event: 'started' | 'updated' | 'completed'; workerSessionId: string; exitCode?: number; label?: string; prompt?: string; modelId?: string; reasoningEffort?: ReasoningEffort }
  | { type: 'mission.tokens'; missionId: string; tokensIn: number; tokensOut: number; contextTokens: number; maxContextTokens?: number }
  | { type: 'mission.transcript'; event: TranscriptEvent }
  | { type: 'mission.permission'; request: PermissionRequest }
  | { type: 'mission.question'; question: MissionQuestion }
  | { type: 'mission.error'; missionId?: string; message: string }
  | { type: 'mission.list'; missions: MissionSummary[] }
  | { type: 'mission.history'; missionId: string; progress: ProgressEntry[]; transcripts: TranscriptEvent[] }
  | { type: 'sessions.history'; missions: HistoryMission[] }
  | { type: 'models.list'; models: ModelInfo[] }
  | { type: 'browser.updated'; state: BrowserState }
  | { type: 'browser.native.request'; request: BrowserNativeRequest }
  | { type: 'browser.closed'; missionId: string }
  | { type: 'browser.error'; missionId?: string; message: string };
