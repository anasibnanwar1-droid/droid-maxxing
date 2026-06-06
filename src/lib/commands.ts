import { bridge } from './bridge';
import type { Autonomy, ConfigurableAgent, ReasoningEffort, SessionInteractionMode } from '../types/bridge';

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
  autonomy: Autonomy;
  workerModel?: string;
  workerReasoning?: ReasoningEffort;
  validatorModel?: string;
  validatorReasoning?: ReasoningEffort;
}) => bridge.send({ type: 'mission.create', ...p });

// Update model/reasoning/compaction for an existing Droid session. A null/
// 'current-model' compactionModel means "follow the current session model".
export const updateSessionSettings = (p: {
  sessionId: string;
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
  compactionModel?: string | null;
  autonomy?: Autonomy;
}) => bridge.send({ type: 'session.updateSettings', ...p });

export const listModels = () => bridge.send({ type: 'models.list' });
export const listSkills = (sessionId?: string) => bridge.send({ type: 'catalog.skills', sessionId });
export const listFactoryDefaults = () => bridge.send({ type: 'settings.defaults' });

export const sendToMission = (missionId: string, text: string) =>
  bridge.send({ type: 'mission.send', missionId, text });

export const sendToAgent = (missionId: string, agentSessionId: string, text: string) =>
  bridge.send({ type: 'agent.send', missionId, agentSessionId, text });

export const respondPermission = (
  missionId: string,
  requestId: string,
  outcome: 'proceed_once' | 'proceed_always' | 'proceed_auto_run' | 'cancel'
) => bridge.send({ type: 'mission.respondPermission', missionId, requestId, outcome });

export const respondQuestion = (
  missionId: string,
  requestId: string,
  cancelled: boolean,
  answers: { index: number; question: string; answer: string }[]
) => bridge.send({ type: 'mission.respondQuestion', missionId, requestId, cancelled, answers });

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

export const listMissions = () => bridge.send({ type: 'mission.list' });

export const loadMissionHistory = (missionId: string) =>
  bridge.send({ type: 'mission.loadHistory', missionId });

export const resumeMission = (sessionId: string) =>
  bridge.send({ type: 'mission.resume', sessionId });

export const updateAgentSettings = (p: {
  missionId?: string;
  agent: ConfigurableAgent;
  modelId?: string | null;
  reasoningEffort?: ReasoningEffort;
}) => bridge.send({ type: 'settings.agent.update', ...p });
