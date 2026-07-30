import type { QueuedPrompt } from '../../hooks/useStore';
import type { BrowserTranscriptReference } from '../../types/bridge';

const MAX_TITLE_LENGTH = 48;

export interface StudioLiveSnapshot {
  appSessionId: string | null;
  live: boolean;
}

export function studioSessionTitle(displayText: string): string {
  const clean = displayText.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Untitled design';
  if (clean === 'Apply the attached canvas references.') return 'Canvas references';
  if (clean.length <= MAX_TITLE_LENGTH) return clean;
  return `${clean.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

export function pendingStudioClientRef(
  expected: Record<string, string>,
  pendingCompose: Record<string, unknown>,
  projectKeys: string[],
): string | undefined {
  const keys = new Set(projectKeys.filter(Boolean));
  return Object.entries(expected).find(
    ([clientRef, projectKey]) => keys.has(projectKey) && clientRef in pendingCompose,
  )?.[0];
}

export function shouldDeliverStudioQueue(
  previous: StudioLiveSnapshot,
  current: StudioLiveSnapshot,
): boolean {
  return (
    previous.live &&
    !current.live &&
    current.appSessionId !== null &&
    previous.appSessionId === current.appSessionId
  );
}

export function createQueuedStudioPrompt({
  id,
  displayText,
  prompt,
  browserRefs,
}: {
  id: string;
  displayText: string;
  prompt: string;
  browserRefs?: BrowserTranscriptReference[];
}): QueuedPrompt {
  return {
    id,
    text: displayText,
    skills: [],
    files: [],
    studio: { prompt, browserRefs },
  };
}
