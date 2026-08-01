// Per-session scratch notes ("parked reminders") for the Context panel: the
// user jots a thought mid-session, it stacks as a line under the box, and
// clicking a line hands its text to the composer to send as a prompt.
//
// Notes persist in localStorage keyed by appSessionId so they survive app
// restarts. Everything loaded from storage is sanitized and bounded: a corrupt
// or bloated payload degrades to an empty map instead of breaking the panel.

export interface SessionNote {
  id: string;
  text: string;
  createdAt: number;
  // Set the first time the note is handed to the composer; drives the filled
  // bullet so the user can see which reminders they already used.
  usedAt: number | null;
}

export type SessionNotesMap = Record<string, SessionNote[]>;

const SESSION_NOTES_STORAGE_KEY = 'droid-session-notes';
export const MAX_NOTE_SESSIONS = 100;
export const MAX_NOTES_PER_SESSION = 100;
export const MAX_NOTE_TEXT_LENGTH = 4000;

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

function sanitizeNote(value: unknown): SessionNote | null {
  if (typeof value !== 'object' || value === null) return null;
  const note = value as Partial<SessionNote>;
  if (typeof note.id !== 'string' || note.id.length === 0) return null;
  if (typeof note.text !== 'string' || note.text.trim().length === 0) return null;
  if (typeof note.createdAt !== 'number' || !Number.isFinite(note.createdAt)) return null;
  return {
    id: note.id,
    text: note.text.slice(0, MAX_NOTE_TEXT_LENGTH),
    createdAt: note.createdAt,
    usedAt: typeof note.usedAt === 'number' && Number.isFinite(note.usedAt) ? note.usedAt : null,
  };
}

export function loadSessionNotes(): SessionNotesMap {
  try {
    const raw = getLocalStorage()?.getItem(SESSION_NOTES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: SessionNotesMap = {};
    for (const [appSessionId, value] of Object.entries(parsed).slice(0, MAX_NOTE_SESSIONS)) {
      if (!Array.isArray(value)) continue;
      const notes = value
        .map(sanitizeNote)
        .filter((note): note is SessionNote => note !== null)
        .slice(0, MAX_NOTES_PER_SESSION);
      if (notes.length > 0) out[appSessionId] = notes;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSessionNotes(map: SessionNotesMap): void {
  try {
    getLocalStorage()?.setItem(SESSION_NOTES_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

const NOTES_INTRO_STORAGE_KEY = 'droid-notes-intro-seen';

// One-time "what's new" spotlight for the Notes panel, per profile.
export function loadNotesIntroSeen(): boolean {
  try {
    return getLocalStorage()?.getItem(NOTES_INTRO_STORAGE_KEY) === '1';
  } catch {
    // Storage unavailable: stay quiet rather than nag on every mount.
    return true;
  }
}

export function dismissNotesIntro(): void {
  try {
    getLocalStorage()?.setItem(NOTES_INTRO_STORAGE_KEY, '1');
  } catch {
    /* ignore */
  }
}

// Newest first: the latest saved note sits directly under the compose box.
// Returns null for blank input so the reducer can no-op.
export function addSessionNote(
  map: SessionNotesMap,
  appSessionId: string,
  text: string,
): SessionNotesMap | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const note: SessionNote = {
    id: crypto.randomUUID(),
    text: trimmed.slice(0, MAX_NOTE_TEXT_LENGTH),
    createdAt: Date.now(),
    usedAt: null,
  };
  // Record index access types as always-present; Partial keeps the lookup
  // honest (the same pattern the store uses for these maps).
  const byId: Partial<SessionNotesMap> = map;
  const existing = byId[appSessionId] ?? [];
  // Re-insert the session at the end of the map so a new note also refreshes
  // its eviction position; the prune below drops least-recently-touched
  // sessions, and bounding here (not only on load) keeps storage capped.
  // Recency relies on string-key insertion order, which holds because
  // daemon session ids always carry a non-numeric suffix ("1:px").
  const rest = Object.fromEntries(Object.entries(map).filter(([id]) => id !== appSessionId));
  const next = { ...rest, [appSessionId]: [note, ...existing].slice(0, MAX_NOTES_PER_SESSION) };
  const sessionIds = Object.keys(next);
  if (sessionIds.length <= MAX_NOTE_SESSIONS) return next;
  return Object.fromEntries(Object.entries(next).slice(sessionIds.length - MAX_NOTE_SESSIONS));
}

// Records that a note was handed to the composer. First use only: repeated
// clicks keep the original usedAt. Returns null when nothing changed so the
// reducer can no-op.
export function markSessionNoteUsed(
  map: SessionNotesMap,
  appSessionId: string,
  noteId: string,
): SessionNotesMap | null {
  const byId: Partial<SessionNotesMap> = map;
  const existing = byId[appSessionId];
  if (!existing) return null;
  const index = existing.findIndex((note) => note.id === noteId);
  if (index < 0 || existing[index].usedAt !== null) return null;
  const notes = existing.slice();
  notes[index] = { ...notes[index], usedAt: Date.now() };
  return { ...map, [appSessionId]: notes };
}

export function removeSessionNote(
  map: SessionNotesMap,
  appSessionId: string,
  noteId: string,
): SessionNotesMap {
  const byId: Partial<SessionNotesMap> = map;
  const existing = byId[appSessionId];
  if (!existing) return map;
  const remaining = existing.filter((note) => note.id !== noteId);
  if (remaining.length === existing.length) return map;
  if (remaining.length > 0) return { ...map, [appSessionId]: remaining };
  // Prune the session key entirely once its last note is gone.
  return Object.fromEntries(Object.entries(map).filter(([id]) => id !== appSessionId));
}
