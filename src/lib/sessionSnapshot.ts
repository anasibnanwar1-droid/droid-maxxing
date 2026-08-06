// Local snapshot of the session list and the active session's recent
// transcript, persisted in localStorage so a reload paints the sidebar and
// the last conversation before the bridge connects. The sidecar's
// sessions.list stays authoritative: hydrated rows that the first list after
// connect does not confirm are pruned by the store, and the restored
// transcript is replaced by the authoritative history page when it arrives.
//
// Everything loaded here is sanitized and bounded: a corrupt or bloated
// payload degrades to no snapshot instead of breaking the store. The key is
// versioned; bump it when the stored shape changes.

import type { SessionSummary, TranscriptEvent } from '../types/bridge';

const SESSION_SNAPSHOT_STORAGE_KEY = 'droid-session-snapshot-v1';
export const MAX_SNAPSHOT_SESSIONS = 200;
export const MAX_SNAPSHOT_TRANSCRIPT_EVENTS = 40;
export const MAX_SNAPSHOT_TRANSCRIPT_BYTES = 256 * 1024;

export interface SessionSnapshot {
  sessions: Record<string, SessionSummary>;
  sessionOrder: string[];
  transcript?: { appSessionId: string; events: TranscriptEvent[] };
}

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// The sidebar rows and unread markers render from these fields; require the
// identity/display ones and pass the rest through once they check out.
function sanitizeSummary(value: unknown): SessionSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const summary = value as Partial<SessionSummary>;
  if (typeof summary.appSessionId !== 'string' || summary.appSessionId.length === 0) return null;
  if (typeof summary.title !== 'string') return null;
  if (typeof summary.cwd !== 'string') return null;
  if (typeof summary.role !== 'string') return null;
  if (typeof summary.phase !== 'string') return null;
  if (!isFiniteNumber(summary.createdAt) || !isFiniteNumber(summary.updatedAt)) return null;
  return {
    ...summary,
    features: Array.isArray(summary.features) ? summary.features : [],
    tokensIn: isFiniteNumber(summary.tokensIn) ? summary.tokensIn : 0,
    tokensOut: isFiniteNumber(summary.tokensOut) ? summary.tokensOut : 0,
    contextTokens: isFiniteNumber(summary.contextTokens) ? summary.contextTokens : 0,
  } as SessionSummary;
}

function sanitizeTranscriptEvent(value: unknown): TranscriptEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const event = value as Partial<TranscriptEvent>;
  if (typeof event.id !== 'string' || event.id.length === 0) return null;
  if (typeof event.appSessionId !== 'string' || event.appSessionId.length === 0) return null;
  if (typeof event.kind !== 'string') return null;
  if (!isFiniteNumber(event.ts)) return null;
  return event as TranscriptEvent;
}

function sanitizeStoredTranscript(
  value: unknown,
  sessions: Record<string, SessionSummary>,
): { appSessionId: string; events: TranscriptEvent[] } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const transcript = value as { appSessionId?: unknown; events?: unknown };
  if (typeof transcript.appSessionId !== 'string') return undefined;
  // Record index access types as always-present; Partial keeps the lookup
  // honest (the same pattern the store uses for these maps).
  const byId: Partial<Record<string, SessionSummary>> = sessions;
  if (!byId[transcript.appSessionId]) return undefined;
  if (!Array.isArray(transcript.events)) return undefined;
  const events = transcript.events
    .map(sanitizeTranscriptEvent)
    .filter((event): event is TranscriptEvent => event !== null)
    .slice(-MAX_SNAPSHOT_TRANSCRIPT_EVENTS);
  return events.length > 0 ? { appSessionId: transcript.appSessionId, events } : undefined;
}

// Keeps the newest events within both the count and serialized-size budgets,
// dropping the oldest half whenever the payload is too large.
function boundTranscriptEvents(events: TranscriptEvent[]): TranscriptEvent[] {
  let kept = events.slice(-MAX_SNAPSHOT_TRANSCRIPT_EVENTS);
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_SNAPSHOT_TRANSCRIPT_BYTES) {
    kept = kept.slice(Math.ceil(kept.length / 2));
  }
  return kept;
}

export function loadSessionSnapshot(): SessionSnapshot | undefined {
  try {
    const raw = getLocalStorage()?.getItem(SESSION_SNAPSHOT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const stored = parsed as { sessions?: unknown; transcript?: unknown };
    if (!Array.isArray(stored.sessions)) return undefined;
    const sessions: Record<string, SessionSummary> = {};
    const sessionOrder: string[] = [];
    for (const value of stored.sessions.slice(0, MAX_SNAPSHOT_SESSIONS)) {
      const summary = sanitizeSummary(value);
      if (!summary) continue;
      sessions[summary.appSessionId] = summary;
      sessionOrder.push(summary.appSessionId);
    }
    if (sessionOrder.length === 0) return undefined;
    const snapshot: SessionSnapshot = { sessions, sessionOrder };
    const transcript = sanitizeStoredTranscript(stored.transcript, sessions);
    if (transcript) snapshot.transcript = transcript;
    return snapshot;
  } catch {
    return undefined;
  }
}

export function saveSessionSnapshot(
  sessions: Record<string, SessionSummary>,
  sessionOrder: string[],
  activeTranscript?: { appSessionId: string; events: TranscriptEvent[] },
): void {
  try {
    const byId: Partial<Record<string, SessionSummary>> = sessions;
    const list: SessionSummary[] = [];
    for (const id of sessionOrder.slice(0, MAX_SNAPSHOT_SESSIONS)) {
      const summary = byId[id];
      if (summary) list.push(summary);
    }
    const payload: {
      sessions: SessionSummary[];
      transcript?: { appSessionId: string; events: TranscriptEvent[] };
    } = { sessions: list };
    if (activeTranscript && activeTranscript.events.length > 0) {
      const events = boundTranscriptEvents(activeTranscript.events);
      if (events.length > 0) {
        payload.transcript = { appSessionId: activeTranscript.appSessionId, events };
      }
    }
    getLocalStorage()?.setItem(SESSION_SNAPSHOT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}
