import type { LiveEnterBehavior } from '../hooks/useStore';
import type { BrowserTranscriptReference, SessionRole, TranscriptEvent } from '../types/bridge';

export const newQueueId = () => `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export type SessionPromptMode = 'queue' | 'now';

export function resolveSessionPromptMode({
  isLive,
  liveEnterBehavior,
  alternate = false,
}: {
  isLive: boolean;
  liveEnterBehavior: LiveEnterBehavior;
  alternate?: boolean;
}): SessionPromptMode {
  if (!isLive) return 'queue';
  const preferred = liveEnterBehavior === 'interrupt' ? 'now' : 'queue';
  if (!alternate) return preferred;
  return preferred === 'now' ? 'queue' : 'now';
}

export function shouldQueueSessionPrompt({
  isLive,
  mode,
  isPrimaryTarget = true,
}: {
  isLive: boolean;
  mode: SessionPromptMode;
  isPrimaryTarget?: boolean;
}): boolean {
  return isPrimaryTarget && isLive && mode === 'queue';
}

export function createLocalUserTranscriptEvent({
  appSessionId,
  text,
  sourceSessionId = 'user',
  role = 'primary',
  skills,
  files,
  browserRefs,
  steered,
  now = Date.now(),
}: {
  appSessionId: string;
  text: string;
  sourceSessionId?: string;
  role?: SessionRole;
  skills?: string[];
  files?: string[];
  browserRefs?: BrowserTranscriptReference[];
  steered?: boolean;
  now?: number;
}): TranscriptEvent {
  return {
    id: `local-${String(now)}`,
    appSessionId,
    sourceSessionId,
    role,
    ts: now,
    kind: 'text',
    text,
    author: 'user',
    ...(skills !== undefined ? { skills } : {}),
    ...(files !== undefined ? { files } : {}),
    ...(browserRefs?.length ? { browserRefs } : {}),
    ...(steered !== undefined ? { steered } : {}),
  };
}
