import { bridge } from './bridge';
import type {
  Autonomy,
  BrowserNativeResult,
  BrowserScrollDirection,
  BrowserViewport,
  BrowserViewportMode,
  ConfigurableSessionRole,
  DesignReference,
  InstallChannel,
  PermissionOutcome,
  ReasoningEffort,
  SessionInteractionMode,
  SessionPurpose,
} from '../types/bridge';

let refCounter = 0;

export const newClientRef = () => `c-${Date.now().toString(36)}-${refCounter++}`;

export const connect = (apiKey: string) => bridge.send({ type: 'connect', apiKey });

export const createSession = (input: {
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
  autonomy: Autonomy;
  workerModel?: string;
  workerReasoning?: ReasoningEffort;
  validatorModel?: string;
  validatorReasoning?: ReasoningEffort;
}) => bridge.send({ type: 'session.create', ...input });

export const updateSessionSettings = (input: {
  appSessionId: string;
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
  autonomy?: Autonomy;
  interactionMode?: SessionInteractionMode;
}) => bridge.send({ type: 'session.updateSettings', ...input });

export const detectEnv = () => bridge.send({ type: 'env.detect' });
export const installCli = (channel: InstallChannel) =>
  bridge.send({ type: 'cli.install', channel });
export const updateCli = (channel?: InstallChannel) => bridge.send({ type: 'cli.update', channel });
export const startCliLogin = () => bridge.send({ type: 'auth.startCliLogin' });
export const requestRuntimeStatus = () => bridge.send({ type: 'runtime.status' });

export const listModels = () => bridge.send({ type: 'catalog.models' });
export const listSkills = (sessionId?: string) =>
  bridge.send({ type: 'catalog.skills', sessionId });
export const listFactoryDefaults = () => bridge.send({ type: 'settings.defaults' });

export const sendToSession = (appSessionId: string, text: string) =>
  bridge.send({ type: 'session.send', appSessionId, text });

export const sendToSessionNow = (appSessionId: string, text: string) =>
  bridge.send({ type: 'session.sendNow', appSessionId, text });

export const sendToChild = (appSessionId: string, providerSessionId: string, text: string) =>
  bridge.send({ type: 'child.send', appSessionId, providerSessionId, text });

export const sendToChildNow = (appSessionId: string, providerSessionId: string, text: string) =>
  bridge.send({ type: 'child.sendNow', appSessionId, providerSessionId, text });

export const respondPermission = (
  appSessionId: string,
  requestId: string,
  outcome: PermissionOutcome,
) => bridge.send({ type: 'approval.respond', appSessionId, requestId, outcome });

export const respondQuestion = (
  appSessionId: string,
  requestId: string,
  cancelled: boolean,
  answers: { index: number; question: string; answer: string }[],
) => bridge.send({ type: 'question.respond', appSessionId, requestId, cancelled, answers });

export const interruptSession = (appSessionId: string) =>
  bridge.send({ type: 'session.interrupt', appSessionId });

export const compactSession = (appSessionId: string, customInstructions?: string) =>
  bridge.send({ type: 'session.compact', appSessionId, customInstructions });

export const interruptChild = (appSessionId: string, providerSessionId: string) =>
  bridge.send({ type: 'child.interrupt', appSessionId, providerSessionId });

export const openChild = (appSessionId: string, providerSessionId: string) =>
  bridge.send({ type: 'child.open', appSessionId, providerSessionId });

export const closeSession = (appSessionId: string) =>
  bridge.send({ type: 'session.close', appSessionId });

export const listSessions = (options?: {
  workspaceCwds?: string[];
  includePlainChats?: boolean;
  limitPerWorkspace?: number;
}) => bridge.send({ type: 'sessions.list', ...options });

export const loadSessionHistory = (appSessionId: string, cursor?: string) =>
  bridge.send({ type: 'session.loadHistory', appSessionId, cursor });

export const resumeSession = (appSessionId: string) =>
  bridge.send({ type: 'session.resume', appSessionId });

export const updateAgentSettings = (input: {
  appSessionId?: string;
  agent: ConfigurableSessionRole;
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
}) => bridge.send({ type: 'settings.agent.update', ...input });

export const updateCompactionSettings = (input: {
  compactionTokenLimit?: number | null;
  compactionTokenLimitPerModel?: Record<string, number>;
}) => bridge.send({ type: 'settings.compaction.update', ...input });

export const openBrowser = (input: {
  appSessionId: string;
  url: string;
  viewport?: BrowserViewport;
  viewportMode?: BrowserViewportMode;
}) => bridge.send({ type: 'browser.open', ...input });

export const closeBrowser = (appSessionId: string) =>
  bridge.send({ type: 'browser.close', appSessionId });

export const reloadBrowser = (appSessionId: string) =>
  bridge.send({ type: 'browser.reload', appSessionId });

export const refreshBrowser = (appSessionId: string) =>
  bridge.send({ type: 'browser.refresh', appSessionId });

export const resizeBrowserViewport = (input: {
  appSessionId: string;
  viewport: BrowserViewport;
  viewportMode: BrowserViewportMode;
}) => bridge.send({ type: 'browser.resizeViewport', ...input });

export const clickBrowser = (input: {
  appSessionId: string;
  ref?: string;
  x?: number;
  y?: number;
  source?: 'agent' | 'user';
}) => bridge.send({ type: 'browser.click', ...input });

export const typeBrowser = (appSessionId: string, text: string) =>
  bridge.send({ type: 'browser.type', appSessionId, text });

export const keypressBrowser = (appSessionId: string, key: string) =>
  bridge.send({ type: 'browser.keypress', appSessionId, key });

export const scrollBrowser = (input: {
  appSessionId: string;
  direction: BrowserScrollDirection;
  pixels?: number;
  ref?: string;
  source?: 'agent' | 'user';
}) => bridge.send({ type: 'browser.scroll', ...input });

export const addDesignReference = (appSessionId: string, reference: DesignReference) =>
  bridge.send({ type: 'browser.design.addReference', appSessionId, reference });

export const sendDesignPrompt = (
  appSessionId: string,
  instruction: string,
  referenceIds: string[],
) =>
  bridge.send({
    type: 'browser.design.sendPrompt',
    appSessionId,
    instruction,
    referenceIds,
  });

export const sendNativeBrowserResult = (result: BrowserNativeResult) =>
  bridge.send({ type: 'browser.native.result', result });
