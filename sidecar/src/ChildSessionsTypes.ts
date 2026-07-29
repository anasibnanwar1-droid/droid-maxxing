import type { FactoryRuntime } from './DroidRuntime.js';
import type { HistoryIndex, PersistedChildSession } from './history.js';
import type { ServerEvent, SessionSummary } from './protocol.js';
import type { SessionRegistry } from './SessionRegistry.js';
import type { SessionTimeline } from './SessionTimeline.js';
import type { SessionEventFlow } from './SessionEventFlow.js';
import type { SessionInteractions } from './SessionInteractions.js';
import type { SessionContext } from './SessionContext.js';
import type { SessionCompaction } from './SessionCompaction.js';
import type { SessionInitResult } from './sessionHelpers.js';
import type { ChildParentLease, ChildRuntimeTarget, ChildSettings } from './ChildSessionState.js';

export type ChildSettingsTarget = ChildRuntimeTarget & {
  parentGeneration: number;
  runtimeGeneration: number;
  configurationGeneration?: number;
};

export interface ChildSessionsDependencies {
  runtime: Pick<FactoryRuntime, 'loadSession'>;
  registry: Pick<SessionRegistry<ChildParentLease>, 'getLive'>;
  history: Pick<HistoryIndex, 'childSessions' | 'childSession' | 'upsertChildSession'>;
  timeline: Pick<SessionTimeline, 'append' | 'appendStatus' | 'replayChild'>;
  eventFlow: Pick<SessionEventFlow, 'beginTurn' | 'applyNotification' | 'applyStreamEvent'>;
  interactions: Pick<SessionInteractions, 'makePermissionHandler' | 'makeAskUserHandler'>;
  context: Pick<SessionContext, 'forgetChild' | 'refresh' | 'startPolling' | 'stopPolling'>;
  compaction: Pick<
    SessionCompaction,
    | 'afterTurn'
    | 'arm'
    | 'cancel'
    | 'handleChildNotification'
    | 'rearmModelChangedChild'
    | 'resolveLimit'
  >;
  resolveDefaultSettings(
    summary: SessionSummary,
    initResult: SessionInitResult,
    role: PersistedChildSession['role'],
  ): ChildSettings;
  isShutdownStarted(): boolean;
  emit(event: ServerEvent): void;
  nextChildSessionId(): string;
  maxOpenSessions: number;
  now(): number;
}
