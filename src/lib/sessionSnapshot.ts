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

import type { BridgeFeature, SessionSummary, TranscriptEvent } from '../types/bridge';

const SESSION_SNAPSHOT_STORAGE_KEY = 'droid-session-snapshot-v1';
export const MAX_SNAPSHOT_SESSIONS = 200;
export const MAX_SNAPSHOT_SUMMARY_BYTES = 512 * 1024;
export const MAX_SNAPSHOT_TRANSCRIPT_EVENTS = 40;
export const MAX_SNAPSHOT_TRANSCRIPT_BYTES = 256 * 1024;

export interface SessionSnapshot {
  sessions: Record<string, SessionSummary>;
  sessionOrder: string[];
  transcript?: { appSessionId: string; events: TranscriptEvent[] };
}

export interface SnapshotInput {
  sessions: Record<string, SessionSummary>;
  sessionOrder: string[];
  activeTranscript?: { appSessionId: string; events: TranscriptEvent[] };
}

export interface SnapshotScheduler {
  push(input: SnapshotInput): void;
  cancel(): void;
}

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const FEATURE_STATUSES = new Set<string>(['pending', 'in_progress', 'completed', 'cancelled']);

// A BridgeFeature carries the mission contract the sidebar and feature panel
// render from; require the identity and contract fields and drop anything that
// does not match the exact shape so a corrupt or injected entry cannot survive
// hydration and render as a half-formed feature.
function sanitizeFeature(value: unknown): BridgeFeature | null {
  if (typeof value !== 'object' || value === null) return null;
  const feature = value as Partial<BridgeFeature>;
  if (typeof feature.id !== 'string' || feature.id.length === 0) return null;
  if (typeof feature.description !== 'string') return null;
  if (typeof feature.status !== 'string' || !FEATURE_STATUSES.has(feature.status)) return null;
  if (typeof feature.skillName !== 'string') return null;
  if (!isStringArray(feature.preconditions)) return null;
  if (!isStringArray(feature.expectedBehavior)) return null;
  if (!isStringArray(feature.verificationSteps)) return null;
  return {
    id: feature.id,
    description: feature.description,
    status: feature.status,
    skillName: feature.skillName,
    preconditions: feature.preconditions,
    expectedBehavior: feature.expectedBehavior,
    verificationSteps: feature.verificationSteps,
    fulfills: isStringArray(feature.fulfills) ? feature.fulfills : undefined,
    milestone: typeof feature.milestone === 'string' ? feature.milestone : undefined,
  };
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
    features: Array.isArray(summary.features)
      ? summary.features
          .map(sanitizeFeature)
          .filter((feature): feature is BridgeFeature => feature !== null)
      : [],
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
  // Events must belong to the transcript's own session: a crafted payload
  // that mixes in events from another session must not leak through.
  const events = boundTranscriptEvents(
    transcript.events
      .map(sanitizeTranscriptEvent)
      .filter((event): event is TranscriptEvent => event !== null)
      .filter((event) => event.appSessionId === transcript.appSessionId),
  );
  return events.length > 0 ? { appSessionId: transcript.appSessionId, events } : undefined;
}

// Keeps the newest events within both the count and serialized-size budgets,
// dropping the oldest half whenever the payload is too large.
function fitByteBudget<T>(items: T[], maxBytes: number, keep: 'start' | 'end'): T[] {
  let kept = items;
  while (kept.length > 0 && JSON.stringify(kept).length > maxBytes) {
    if (kept.length === 1) return [];
    const midpoint = Math.ceil(kept.length / 2);
    kept = keep === 'start' ? kept.slice(0, midpoint) : kept.slice(midpoint);
  }
  return kept;
}

function boundTranscriptEvents(events: TranscriptEvent[]): TranscriptEvent[] {
  return fitByteBudget(
    events.slice(-MAX_SNAPSHOT_TRANSCRIPT_EVENTS),
    MAX_SNAPSHOT_TRANSCRIPT_BYTES,
    'end',
  );
}

export function loadSessionSnapshot(): SessionSnapshot | undefined {
  try {
    const raw = getLocalStorage()?.getItem(SESSION_SNAPSHOT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const stored = parsed as { sessions?: unknown; transcript?: unknown };
    if (!Array.isArray(stored.sessions)) return undefined;
    const seen = new Set<string>();
    let list: SessionSummary[] = [];
    for (const value of stored.sessions.slice(0, MAX_SNAPSHOT_SESSIONS)) {
      const summary = sanitizeSummary(value);
      if (!summary || seen.has(summary.appSessionId)) continue;
      seen.add(summary.appSessionId);
      list.push(summary);
    }
    // Bound the deserialized payload: a crafted or corrupt blob with a single
    // oversized summary must not bypass the byte budget on hydration.
    list = fitByteBudget(list, MAX_SNAPSHOT_SUMMARY_BYTES, 'start');
    if (list.length === 0) return undefined;
    const sessions: Record<string, SessionSummary> = {};
    const sessionOrder = list.map((summary) => {
      sessions[summary.appSessionId] = summary;
      return summary.appSessionId;
    });
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
    let list: SessionSummary[] = [];
    for (const id of sessionOrder.slice(0, MAX_SNAPSHOT_SESSIONS)) {
      const summary = byId[id];
      if (summary) list.push(summary);
    }
    // sessionOrder is newest-first, so keeping the front of the list keeps
    // the most recent sessions when a pathological payload exceeds budget.
    list = fitByteBudget(list, MAX_SNAPSHOT_SUMMARY_BYTES, 'start');
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

// Coalesces snapshot writes for the store provider: a write is scheduled only
// when one of the tracked references actually changed, and the latest push
// wins within the debounce window. The scheduler owns its timer (rather than
// relying on effect cleanup), so an unrelated re-render can never cancel a
// pending write. cancel() is for unmount.
export function createSnapshotScheduler(delayMs: number): SnapshotScheduler {
  let prev: SnapshotInput | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    push(input: SnapshotInput): void {
      const prevInput = prev;
      prev = input;
      if (prevInput) {
        const unchanged =
          prevInput.sessions === input.sessions &&
          prevInput.sessionOrder === input.sessionOrder &&
          prevInput.activeTranscript?.appSessionId === input.activeTranscript?.appSessionId &&
          prevInput.activeTranscript?.events === input.activeTranscript?.events;
        if (unchanged) return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        saveSessionSnapshot(input.sessions, input.sessionOrder, input.activeTranscript);
      }, delayMs);
    },
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
