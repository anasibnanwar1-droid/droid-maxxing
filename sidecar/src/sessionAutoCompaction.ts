// Lifecycle of the daemon's in-place auto-compaction as observed by the app:
// raise the compacting flag on the start notification, settle it on
// completion (or an idle working state, or a watchdog expiry), and drain
// whatever sends queued behind it. SessionManager stays the owner of all
// state; this module only encodes the transitions against a narrow host view.

import { extractCompactionNotification, extractDroidWorkingState } from './normalize.js';
import {
  AUTO_COMPACTION_WATCHDOG_MS,
  type AutoCompactionWatchdogs,
} from './autoCompactionWatchdog.js';
import type { SessionRole } from './protocol.js';

const ignoreError = (): void => undefined;

export interface CompactingChildState {
  providerSessionId: string;
  appSessionId: string;
  role: SessionRole;
  streaming: boolean;
  autoCompacting: boolean;
  pendingSends: string[];
  closeWhenIdle?: boolean;
}

export interface CompactingSessionState<C extends CompactingChildState> {
  summary: { appSessionId: string; autoCompactions?: number };
  streaming: boolean;
  compacting?: boolean;
  autoCompacting: boolean;
  pendingSends: string[];
  childSessions: Map<string, C>;
}

export interface AutoCompactionHost<
  C extends CompactingChildState,
  L extends CompactingSessionState<C>,
  S,
> {
  watchdogs: AutoCompactionWatchdogs;
  sessions(): Iterable<L>;
  findSession(appSessionId: string): L | undefined;
  childSessionCompactions: Map<string, number>;
  emitCompactionStatus(
    appSessionId: string,
    text: string,
    providerSessionId: string,
    role: SessionRole,
  ): void;
  patchSummary(
    appSessionId: string,
    patch: {
      contextTokens?: number;
      contextAccuracy?: undefined;
      autoCompactions?: number;
      queuedSends?: number;
    },
  ): void;
  refreshContext(providerSessionId: string, session: S): Promise<void>;
  settlePrimary(appSessionId: string): void;
  driveChildSession(childSession: C, text: string): Promise<void>;
  closeChildSession(appSessionId: string, providerSessionId: string): Promise<void>;
  emitChildSessionPaused(childSession: C): void;
}

interface CompactionNotificationTarget<S> {
  appSessionId: string;
  providerSessionId: string;
  role: SessionRole;
  session: S;
}

// Returns true when the notification belonged to the compaction lifecycle and
// must not be normalized as ordinary session output.
export function handleCompactionNotification<
  C extends CompactingChildState,
  L extends CompactingSessionState<C>,
  S,
>(
  host: AutoCompactionHost<C, L, S>,
  target: CompactionNotificationTarget<S>,
  note: Record<string, unknown>,
): boolean {
  const { appSessionId, providerSessionId, role, session } = target;
  const compaction = extractCompactionNotification(note);
  if (!compaction) {
    // Only an idle state settles a missing session_compacted notification.
    const state = extractDroidWorkingState(note);
    if (state === 'idle') setAutoCompacting(host, appSessionId, providerSessionId, role, false);
    return false;
  }
  if (compaction.kind === 'started') {
    setAutoCompacting(host, appSessionId, providerSessionId, role, true);
    host.emitCompactionStatus(appSessionId, 'Compacting conversation...', providerSessionId, role);
    return true;
  }

  const liveSession = host.findSession(appSessionId);
  const active =
    providerSessionId === appSessionId
      ? liveSession?.autoCompacting
      : liveSession?.childSessions.get(providerSessionId)?.autoCompacting;
  if (!active) return true;
  setAutoCompacting(host, appSessionId, providerSessionId, role, false);
  host.emitCompactionStatus(appSessionId, 'Compaction complete.', providerSessionId, role);

  if (providerSessionId === appSessionId) {
    if (liveSession) {
      host.patchSummary(appSessionId, {
        contextTokens: 0,
        contextAccuracy: undefined,
        autoCompactions: (liveSession.summary.autoCompactions ?? 0) + 1,
      });
    }
  } else {
    host.childSessionCompactions.set(
      providerSessionId,
      (host.childSessionCompactions.get(providerSessionId) ?? 0) + 1,
    );
  }
  void host.refreshContext(providerSessionId, session).catch(ignoreError);
  return true;
}

export function onAutoCompactionWatchdogExpired<
  C extends CompactingChildState,
  L extends CompactingSessionState<C>,
  S,
>(host: AutoCompactionHost<C, L, S>, sessionKey: string): void {
  const liveSession = host.findSession(sessionKey);
  if (liveSession?.autoCompacting) {
    console.warn(`[compaction] watchdog settled a stale auto-compaction on ${sessionKey}`);
    setAutoCompacting(
      host,
      liveSession.summary.appSessionId,
      liveSession.summary.appSessionId,
      'primary',
      false,
    );
    return;
  }
  for (const owner of host.sessions()) {
    const childSession = owner.childSessions.get(sessionKey);
    if (childSession?.autoCompacting) {
      console.warn(`[compaction] watchdog settled a stale auto-compaction on ${sessionKey}`);
      setAutoCompacting(host, owner.summary.appSessionId, sessionKey, childSession.role, false);
      return;
    }
  }
}

function setAutoCompacting<C extends CompactingChildState, L extends CompactingSessionState<C>, S>(
  host: AutoCompactionHost<C, L, S>,
  appSessionId: string,
  providerSessionId: string,
  role: SessionRole,
  active: boolean,
): void {
  const liveSession = host.findSession(appSessionId);
  if (!liveSession) return;
  if (role === 'primary') {
    setPrimaryAutoCompacting(host, liveSession, active);
    return;
  }
  setChildAutoCompacting(host, liveSession, providerSessionId, active);
}

function setPrimaryAutoCompacting<
  C extends CompactingChildState,
  L extends CompactingSessionState<C>,
  S,
>(host: AutoCompactionHost<C, L, S>, liveSession: L, active: boolean): void {
  const wasActive = liveSession.autoCompacting;
  liveSession.autoCompacting = active;
  if (active) host.watchdogs.arm(liveSession.summary.appSessionId, AUTO_COMPACTION_WATCHDOG_MS);
  else host.watchdogs.clear(liveSession.summary.appSessionId);
  if (active || !wasActive || liveSession.streaming || liveSession.compacting) return;
  host.settlePrimary(liveSession.summary.appSessionId);
}

function setChildAutoCompacting<
  C extends CompactingChildState,
  L extends CompactingSessionState<C>,
  S,
>(
  host: AutoCompactionHost<C, L, S>,
  liveSession: L,
  providerSessionId: string,
  active: boolean,
): void {
  const childSession = liveSession.childSessions.get(providerSessionId);
  if (!childSession) return;
  const wasActive = childSession.autoCompacting;
  childSession.autoCompacting = active;
  if (active) host.watchdogs.arm(providerSessionId, AUTO_COMPACTION_WATCHDOG_MS);
  else host.watchdogs.clear(providerSessionId);
  if (active || !wasActive || childSession.streaming) return;
  if (childSession.pendingSends.length === 0 && childSession.closeWhenIdle) {
    void host.closeChildSession(childSession.appSessionId, childSession.providerSessionId);
    return;
  }
  const next = childSession.pendingSends.shift();
  if (next !== undefined) void host.driveChildSession(childSession, next);
  else host.emitChildSessionPaused(childSession);
}
