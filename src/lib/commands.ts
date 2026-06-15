import { bridge } from './bridge';
import type {
  Autonomy,
  BrowserNativeResult,
  BrowserScrollDirection,
  BrowserViewport,
  BrowserViewportMode,
  ConfigurableAgent,
  DesignReference,
  InstallChannel,
  PermissionOutcome,
  ReasoningEffort,
  SessionInteractionMode,
} from '../types/bridge';

let refCounter = 0;

export const newClientRef = () => `c-${Date.now().toString(36)}-${refCounter++}`;

export const connect = (apiKey: string) => bridge.send({ type: 'connect', apiKey });

export const createMission = (p: {
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
}) => bridge.send({ type: 'mission.create', ...p });

// Update live model/reasoning/autonomy for an existing Droid session.
export const updateSessionSettings = (p: {
  sessionId: string;
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
  autonomy?: Autonomy;
}) => bridge.send({ type: 'session.updateSettings', ...p });

export const detectEnv = () => bridge.send({ type: 'env.detect' });
export const installCli = (channel: InstallChannel) =>
  bridge.send({ type: 'cli.install', channel });
export const updateCli = (channel?: InstallChannel) => bridge.send({ type: 'cli.update', channel });
export const startCliLogin = () => bridge.send({ type: 'auth.startCliLogin' });
export const requestRuntimeStatus = () => bridge.send({ type: 'runtime.status' });

export const listModels = () => bridge.send({ type: 'models.list' });
export const listSkills = (sessionId?: string) =>
  bridge.send({ type: 'catalog.skills', sessionId });
export const listFactoryDefaults = () => bridge.send({ type: 'settings.defaults' });
export const updateCompactionSettings = (p: {
  compactionTokenLimit?: number | null;
  compactionTokenLimitPerModel?: Record<string, number>;
}) => bridge.send({ type: 'settings.compaction.update', ...p });

type CompactionSettingsPatch = {
  compactionTokenLimit?: number | null;
  compactionTokenLimitPerModel?: Record<string, number>;
};

export const sendToMission = (
  missionId: string,
  text: string,
  compaction?: CompactionSettingsPatch,
) => bridge.send({ type: 'mission.send', missionId, text, ...compaction });

export const sendToMissionNow = (
  missionId: string,
  text: string,
  compaction?: CompactionSettingsPatch,
) => bridge.send({ type: 'mission.sendNow', missionId, text, ...compaction });

export const sendToAgent = (
  missionId: string,
  agentSessionId: string,
  text: string,
  compaction?: CompactionSettingsPatch,
) => bridge.send({ type: 'agent.send', missionId, agentSessionId, text, ...compaction });

export const sendToAgentNow = (
  missionId: string,
  agentSessionId: string,
  text: string,
  compaction?: CompactionSettingsPatch,
) => bridge.send({ type: 'agent.sendNow', missionId, agentSessionId, text, ...compaction });

export const respondPermission = (
  missionId: string,
  requestId: string,
  outcome: PermissionOutcome,
  compaction?: CompactionSettingsPatch,
) =>
  bridge.send({ type: 'mission.respondPermission', missionId, requestId, outcome, ...compaction });

export const respondQuestion = (
  missionId: string,
  requestId: string,
  cancelled: boolean,
  answers: { index: number; question: string; answer: string }[],
  compaction?: CompactionSettingsPatch,
) =>
  bridge.send({
    type: 'mission.respondQuestion',
    missionId,
    requestId,
    cancelled,
    answers,
    ...compaction,
  });

export const interruptMission = (missionId: string) =>
  bridge.send({ type: 'mission.interrupt', missionId });

export const compactSession = (missionId: string, customInstructions?: string) =>
  bridge.send({ type: 'mission.compact', missionId, customInstructions });

export const interruptAgent = (missionId: string, agentSessionId: string) =>
  bridge.send({ type: 'agent.interrupt', missionId, agentSessionId });

export const setMissionAutonomy = (missionId: string, autonomy: Autonomy) =>
  bridge.send({ type: 'mission.setAutonomy', missionId, autonomy });

export const setInteractionMode = (missionId: string, mode: SessionInteractionMode) =>
  bridge.send({ type: 'mission.setInteractionMode', missionId, mode });

export const subscribeWorker = (missionId: string, workerSessionId: string) =>
  bridge.send({ type: 'mission.subscribeWorker', missionId, workerSessionId });

export const closeMission = (missionId: string) =>
  bridge.send({ type: 'mission.close', missionId });

export const listMissions = (options?: {
  workspaceCwds?: string[];
  includePlainChats?: boolean;
  limitPerWorkspace?: number;
}) => bridge.send({ type: 'mission.list', ...options });

export const loadMissionHistory = (missionId: string) =>
  bridge.send({ type: 'mission.loadHistory', missionId });

export const loadOlderMissionHistory = (missionId: string, cursor: string) =>
  bridge.send({ type: 'mission.loadHistory', missionId, cursor });

export const resumeMission = (sessionId: string) =>
  bridge.send({ type: 'mission.resume', sessionId });

export const updateAgentSettings = (p: {
  missionId?: string;
  agent: ConfigurableAgent;
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
}) => bridge.send({ type: 'settings.agent.update', ...p });

export const openBrowser = (p: {
  missionId: string;
  url: string;
  viewport?: BrowserViewport;
  viewportMode?: BrowserViewportMode;
}) => bridge.send({ type: 'browser.open', ...p });

export const closeBrowser = (missionId: string) =>
  bridge.send({ type: 'browser.close', missionId });

export const reloadBrowser = (missionId: string) =>
  bridge.send({ type: 'browser.reload', missionId });

export const refreshBrowser = (missionId: string) =>
  bridge.send({ type: 'browser.refresh', missionId });

export const resizeBrowserViewport = (p: {
  missionId: string;
  viewport: BrowserViewport;
  viewportMode: BrowserViewportMode;
}) => bridge.send({ type: 'browser.resizeViewport', ...p });

export const clickBrowser = (p: {
  missionId: string;
  ref?: string;
  x?: number;
  y?: number;
  source?: 'agent' | 'user';
}) => bridge.send({ type: 'browser.click', ...p });

export const typeBrowser = (missionId: string, text: string) =>
  bridge.send({ type: 'browser.type', missionId, text });

export const keypressBrowser = (missionId: string, key: string) =>
  bridge.send({ type: 'browser.keypress', missionId, key });

export const scrollBrowser = (p: {
  missionId: string;
  direction: BrowserScrollDirection;
  pixels?: number;
  source?: 'agent' | 'user';
}) => bridge.send({ type: 'browser.scroll', ...p });

export const addDesignReference = (missionId: string, reference: DesignReference) =>
  bridge.send({ type: 'browser.design.addReference', missionId, reference });

export const sendDesignPrompt = (
  missionId: string,
  instruction: string,
  referenceIds: string[],
  compaction?: CompactionSettingsPatch,
) =>
  bridge.send({
    type: 'browser.design.sendPrompt',
    missionId,
    instruction,
    referenceIds,
    ...compaction,
  });

export const sendNativeBrowserResult = (result: BrowserNativeResult) =>
  bridge.send({ type: 'browser.native.result', result });
