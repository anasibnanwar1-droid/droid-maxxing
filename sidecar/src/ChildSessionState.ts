import type { FactorySession } from './DroidRuntime.js';
import type { PersistedChildSession, PersistedChildSpawnLink } from './history.js';
import type { Autonomy, ReasoningEffort, SessionSummary } from './protocol.js';
import { normalizeAutonomy, reasoningValue, type SessionInitResult } from './sessionHelpers.js';
/* eslint-disable @typescript-eslint/no-unused-vars -- persisted-only fields are intentionally omitted. */
export interface ChildIdentity {
  parentAppSessionId: string;
  childSessionId: string;
}
export interface ChildSettings {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  autonomy?: Autonomy;
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
export interface ChildTurnState {
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
  // Confirmed effective autonomy reported by the child's init result. Runtime-
  // scoped: set when the child opens, cleared when its runtime closes or is
  // replaced. Never persisted and never inherited from the parent.
  autonomy?: Autonomy;
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
    autonomy: normalizeAutonomy(init.settings?.autonomyLevel),
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
  // Autonomy is runtime-scoped: only a live child reports its confirmed value.
  if ('identity' in child && child.runtime && child.autonomy) {
    return { ...summary, autonomy: child.autonomy };
  }
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
