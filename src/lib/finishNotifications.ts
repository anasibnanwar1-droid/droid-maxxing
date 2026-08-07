// Desktop turn-finished notifications: when a session stops generating, show a
// short OS banner (snippet + optional sound). Settings persist in localStorage.

import type { SessionSummary, TranscriptEvent } from '../types/bridge';
import { classifyEvent } from './transcript';
import { sessionIsLive } from './sessions';

export interface FinishNotificationSettings {
  enabled: boolean;
  /** Skip the banner while DROIDEX is in the foreground. */
  suppressWhenFocused: boolean;
  playSound: boolean;
  /** Also notify for the chat the user is currently viewing. */
  notifyActiveSession: boolean;
}

export const DEFAULT_FINISH_NOTIFICATION_SETTINGS: FinishNotificationSettings = {
  enabled: true,
  suppressWhenFocused: true,
  playSound: true,
  notifyActiveSession: true,
};

const STORAGE_KEY = 'droid-finish-notifications-v1';
export const NOTIFICATION_SNIPPET_MAX = 160;

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

export function normalizeFinishNotificationSettings(value: unknown): FinishNotificationSettings {
  const base = { ...DEFAULT_FINISH_NOTIFICATION_SETTINGS };
  if (!value || typeof value !== 'object') return base;
  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    suppressWhenFocused:
      typeof raw.suppressWhenFocused === 'boolean'
        ? raw.suppressWhenFocused
        : base.suppressWhenFocused,
    playSound: typeof raw.playSound === 'boolean' ? raw.playSound : base.playSound,
    notifyActiveSession:
      typeof raw.notifyActiveSession === 'boolean'
        ? raw.notifyActiveSession
        : base.notifyActiveSession,
  };
}

export function loadFinishNotificationSettings(): FinishNotificationSettings {
  try {
    const raw = getLocalStorage()?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FINISH_NOTIFICATION_SETTINGS };
    return normalizeFinishNotificationSettings(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_FINISH_NOTIFICATION_SETTINGS };
  }
}

export function saveFinishNotificationSettings(
  settings: FinishNotificationSettings,
): FinishNotificationSettings {
  const next = normalizeFinishNotificationSettings(settings);
  try {
    getLocalStorage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

/** Collapse whitespace and cap length for the OS notification body. */
export function notificationSnippet(text: string, max = NOTIFICATION_SNIPPET_MAX): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= max) return cleaned;
  const slice = cleaned.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

/** Latest primary-agent assistant chat text for the notification body. */
export function latestAssistantSnippet(
  events: readonly TranscriptEvent[] | undefined,
  max = NOTIFICATION_SNIPPET_MAX,
): string {
  if (!events || events.length === 0) return '';
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.role !== 'primary') continue;
    if (classifyEvent(ev) !== 'assistant_chat') continue;
    const text = typeof ev.text === 'string' ? ev.text : '';
    const snippet = notificationSnippet(text, max);
    if (snippet) return snippet;
  }
  return '';
}

/** Renderer-side foreground check (visibility + focus). */
export function isAppInForeground(
  doc: Pick<Document, 'visibilityState' | 'hasFocus'> | null | undefined = typeof document !==
  'undefined'
    ? document
    : undefined,
): boolean {
  if (!doc) return false;
  if (doc.visibilityState === 'hidden') return false;
  if (typeof doc.hasFocus === 'function') return doc.hasFocus();
  return true;
}

export type FinishNotifyDecision =
  | { kind: 'skip' }
  | { kind: 'notify'; title: string; body: string; silent: boolean };

/**
 * Decide whether a finished session should raise a desktop banner.
 * Call with `assistantSnippet` only after cheap gates pass, or pass '' and
 * fill the body later — snippet is only needed when kind is notify.
 */
export function decideFinishNotification(input: {
  settings: FinishNotificationSettings;
  session: Pick<SessionSummary, 'appSessionId' | 'title' | 'phase'>;
  isActiveSession: boolean;
  assistantSnippet: string;
  appInForeground: boolean;
}): FinishNotifyDecision {
  const { settings, session, isActiveSession, assistantSnippet, appInForeground } = input;
  if (!settings.enabled) return { kind: 'skip' };
  if (!settings.notifyActiveSession && isActiveSession) return { kind: 'skip' };
  if (settings.suppressWhenFocused && appInForeground) return { kind: 'skip' };

  const failed = session.phase === 'failed';
  const sessionTitle = session.title.trim() || 'Chat';
  return {
    kind: 'notify',
    title: failed ? `Failed · ${sessionTitle}` : sessionTitle,
    body: failed
      ? assistantSnippet || 'The model hit an error before finishing.'
      : assistantSnippet || 'The model finished its response.',
    silent: !settings.playSound,
  };
}

/** Working→idle edges only (never cold history that was idle on first scan). */
export function collectFinishedSessions(input: {
  sessions: Record<string, SessionSummary>;
  previouslyWorking: ReadonlySet<string>;
}): { finished: SessionSummary[]; stillWorking: Set<string> } {
  const stillWorking = new Set<string>();
  const finished: SessionSummary[] = [];
  for (const session of Object.values(input.sessions)) {
    if (!session.appSessionId) continue;
    // Same generating rule as the rest of the app (streaming + phase).
    if (sessionIsLive(session)) {
      stillWorking.add(session.appSessionId);
      continue;
    }
    if (input.previouslyWorking.has(session.appSessionId)) {
      finished.push(session);
    }
  }
  return { finished, stillWorking };
}
