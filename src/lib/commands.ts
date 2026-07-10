import { bridge } from './bridge';
import type {
  Autonomy,
  BrowserNativeResult,
  BrowserScrollDirection,
  BrowserViewport,
  BrowserViewportMode,
  ConfigurableSessionRole,
  DesignReference,
  DesignSwapReplacementRef,
  DesignSwapStrategy,
  DesignSwapTarget,
  InstallChannel,
  PermissionOutcome,
  ReasoningEffort,
  SessionInteractionMode,
  SessionPurpose,
  ValidatorConfig,
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
export const listSkills = (providerSessionId?: string) =>
  bridge.send({ type: 'catalog.skills', providerSessionId });
export const listFactoryDefaults = () => bridge.send({ type: 'settings.defaults' });

export const sendToSession = (appSessionId: string, text: string) =>
  bridge.send({ type: 'session.send', appSessionId, text });

export const sendToSessionNow = (appSessionId: string, text: string) =>
  bridge.send({ type: 'session.sendNow', appSessionId, text });

export const sendToChild = (parentAppSessionId: string, childSessionId: string, text: string) =>
  bridge.send({
    type: 'child.send',
    parentAppSessionId,
    childSessionId,
    text,
  });

export const sendToChildNow = (parentAppSessionId: string, childSessionId: string, text: string) =>
  bridge.send({
    type: 'child.sendNow',
    parentAppSessionId,
    childSessionId,
    text,
  });

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

export const interruptChild = (parentAppSessionId: string, childSessionId: string) =>
  bridge.send({
    type: 'child.interrupt',
    parentAppSessionId,
    childSessionId,
  });

export const interruptVisibleSession = (
  parentAppSessionId: string,
  childSessionId?: string | null,
) =>
  childSessionId
    ? interruptChild(parentAppSessionId, childSessionId)
    : interruptSession(parentAppSessionId);

let childOpenRequestCounter = 0;
export const newChildOpenRequestId = () =>
  `child-open-${Date.now().toString(36)}-${(childOpenRequestCounter++).toString(36)}`;

export const openChild = (parentAppSessionId: string, childSessionId: string, requestId: string) =>
  bridge.send({ type: 'child.open', parentAppSessionId, childSessionId, requestId });

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

export const updateChildSettings = (input: {
  parentAppSessionId: string;
  childSessionId: string;
  modelId: string | null;
  reasoningEffort?: ReasoningEffort;
}) => {
  bridge.send({ type: 'child.updateSettings', ...input });
};

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

export const readDesignDna = (cwd: string) => bridge.send({ type: 'design.dna.read', cwd });

export const writeDesignDna = (cwd: string, file: 'design' | 'motion', content: string) =>
  bridge.send({ type: 'design.dna.write', cwd, file, content });

export const scanDesignDna = (cwd: string) => bridge.send({ type: 'design.dna.scan', cwd });

export const listDnaLibraries = () => bridge.send({ type: 'design.dna.libraries' });

export const applyDnaLibrary = (cwd: string, libraryId: string) =>
  bridge.send({ type: 'design.dna.applyLibrary', cwd, libraryId });

export const finalizeDesignDna = (
  cwd: string,
  name: string,
  opts?: {
    tagline?: string;
    source?: 'scan' | 'interview' | 'library' | 'manual';
    sourceLibraryId?: string;
  },
) =>
  bridge.send({
    type: 'design.dna.finalize',
    cwd,
    name,
    tagline: opts?.tagline,
    source: opts?.source ?? 'manual',
    sourceLibraryId: opts?.sourceLibraryId,
  });

export const listSavedDna = (cwd: string) => bridge.send({ type: 'design.dna.savedList', cwd });

export const applySavedDna = (cwd: string, id: string) =>
  bridge.send({ type: 'design.dna.savedApply', cwd, id });

export const deleteSavedDna = (cwd: string, id: string) =>
  bridge.send({ type: 'design.dna.savedDelete', cwd, id });

export const readValidatorConfig = (cwd: string) =>
  bridge.send({ type: 'design.validator.readConfig', cwd });

export const writeValidatorConfig = (cwd: string, config: ValidatorConfig) =>
  bridge.send({ type: 'design.validator.writeConfig', cwd, config });

export const runValidator = (cwd: string, missionId: string) =>
  bridge.send({ type: 'design.validator.run', cwd, missionId });

export const fixValidatorFindings = (cwd: string, missionId: string) =>
  bridge.send({ type: 'design.validator.fix', cwd, missionId });

export const listDesignLibrary = (cwd: string) => bridge.send({ type: 'design.library.list', cwd });

export const saveDesignLibraryItem = (p: {
  cwd: string;
  missionId: string;
  referenceId: string;
  name?: string;
  note?: string;
}) => bridge.send({ type: 'design.library.save', ...p });

export const deleteDesignLibraryItem = (cwd: string, id: string) =>
  bridge.send({ type: 'design.library.delete', cwd, id });

export const extractDesignLibraryTokens = (cwd: string, id: string) =>
  bridge.send({ type: 'design.library.extract', cwd, id });

export const listPrototypes = (cwd: string) => bridge.send({ type: 'design.prototypes.list', cwd });

export const scanComponentRegistry = (cwd: string) =>
  bridge.send({ type: 'design.registry.scan', cwd });

export const requestDesignSwap = (p: {
  cwd: string;
  missionId: string;
  target: DesignSwapTarget;
  replacement: DesignSwapReplacementRef;
  strategy: DesignSwapStrategy;
  note?: string;
}) => bridge.send({ type: 'design.swap', ...p });

export const commitDesignChange = (cwd: string, message: string) =>
  bridge.send({ type: 'design.git.commit', cwd, message });

export const renderDesignPreview = (cwd: string) =>
  bridge.send({ type: 'design.preview.render', cwd });
