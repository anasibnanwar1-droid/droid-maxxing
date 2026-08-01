import type { FactorySession } from './DroidRuntime.js';
import type { PersistedChildSession, PersistedChildSpawnLink } from './history.js';
import type { ReasoningEffort, SessionSummary } from './protocol.js';
import { reasoningValue, type SessionInitResult } from './sessionHelpers.js';
/* eslint-disable @typescript-eslint/no-unused-vars -- persisted-only fields are intentionally omitted. */
export interface ChildIdentity {
  parentAppSessionId: string;
  childSessionId: string;
}
export interface ChildSettings {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
}
export interface ChildSpawnObservation {
  parentAppSessionId: string;
  providerSessionId?: string;
  role: PersistedChildSession['role'];
  spawnLink?: PersistedChildSession['spawnLink'];
  label?: string;
  prompt?: string;
  done?: boolean;
}
export interface ChildParentLease {
  summary: SessionSummary;
  session: FactorySession;
  closeMode?: 'discard-pending' | 'preserve-pending';
}
export interface ChildRuntimeState {
  session: FactorySession;
  generation: number;
  lastUsedAt: number;
  unsubscribe?: () => void;
}
interface ChildTurnState {
  generation: number;
  phase: 'idle' | 'streaming';
  autoCompacting: boolean;
  pendingSends: string[];
  interruptingForSteer: boolean;
  interrupting: boolean;
}
export interface ChildSessionState {
  identity: ChildIdentity;
  role: PersistedChildSession['role'];
  status: PersistedChildSession['status'];
  providerSessionId?: string;
  label?: string;
  prompt?: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  spawnLink?: PersistedChildSession['spawnLink'];
  transcriptAvailable: boolean;
  startedAt?: number;
  runtimeGeneration: number;
  configurationGeneration: number;
  retiredProviderSessionIds: Set<string>;
  runtime?: ChildRuntimeState;
  turn: ChildTurnState;
  closeWhenIdle: boolean;
  mutationTail?: Promise<void>;
}
export interface ChildOpenAttempt {
  settled: Promise<void>;
  settle(): void;
  cancelled: Promise<void>;
  cancel(): void;
  isCancelled: boolean;
  provisionalSession?: FactorySession;
  provisionalClose?: Promise<void>;
}
export interface ParentChildSessions {
  parentAppSessionId: string;
  generation: number;
  lease: ChildParentLease;
  children: Map<string, ChildSessionState>;
  pendingSpawns: Map<string, ChildSpawnObservation>;
  openAttempts: Map<string, ChildOpenAttempt>;
  reservedOpenSlots: Set<string>;
  closing: boolean;
}
export interface ChildRuntimeTarget {
  parent: ParentChildSessions;
  child: ChildSessionState;
  runtime: ChildRuntimeState;
}
export function childIdentity(parentAppSessionId: string, childSessionId: string): ChildIdentity {
  return { parentAppSessionId, childSessionId };
}

export function childSettingsFromInit(init: SessionInitResult): ChildSettings {
  return {
    modelId: init.settings?.modelId,
    reasoningEffort: reasoningValue(init.settings?.reasoningEffort),
  };
}

export function childStateFromRecord(record: PersistedChildSession): ChildSessionState {
  const { parentAppSessionId, childSessionId, updatedAt: _updatedAt, ...persisted } = record;
  return {
    identity: childIdentity(parentAppSessionId, childSessionId),
    ...persisted,
    runtimeGeneration: 1,
    configurationGeneration: 1,
    retiredProviderSessionIds: new Set(),
    turn: {
      generation: 0,
      phase: 'idle',
      autoCompacting: false,
      pendingSends: [],
      interruptingForSteer: false,
      interrupting: false,
    },
    closeWhenIdle: false,
  };
}

export function persistedChild(child: ChildSessionState): PersistedChildSession {
  return {
    ...child.identity,
    role: child.role,
    status: child.status,
    modelId: child.modelId,
    transcriptAvailable: child.transcriptAvailable,
    updatedAt: 0,
    ...(child.providerSessionId ? { providerSessionId: child.providerSessionId } : {}),
    ...(child.label ? { label: child.label } : {}),
    ...(child.prompt ? { prompt: child.prompt } : {}),
    ...(child.reasoningEffort ? { reasoningEffort: child.reasoningEffort } : {}),
    ...(child.spawnLink ? { spawnLink: child.spawnLink } : {}),
    ...(child.startedAt === undefined ? {} : { startedAt: child.startedAt }),
  };
}

export function childSummary(child: ChildSessionState | PersistedChildSession) {
  const record = 'identity' in child ? persistedChild(child) : child;
  const { providerSessionId: _provider, updatedAt: _updatedAt, ...summary } = record;
  return summary;
}

export function findChildByProvider(
  parent: ParentChildSessions,
  providerSessionId: string,
): ChildSessionState | undefined {
  return [...parent.children.values()].find(
    (child) =>
      child.runtime?.session.sessionId === providerSessionId ||
      child.providerSessionId === providerSessionId,
  );
}

export function findChildBySpawn(parent: ParentChildSessions, spawnLink: PersistedChildSpawnLink) {
  return [...parent.children.values()].find(
    (child) => child.spawnLink?.kind === spawnLink.kind && child.spawnLink.id === spawnLink.id,
  );
}

export function childAcceptsWork(child: ChildSessionState): boolean {
  return child.status !== 'completed' && !child.closeWhenIdle;
}
