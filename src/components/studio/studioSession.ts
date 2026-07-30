import type { QueuedPrompt } from '../../hooks/useStore';
import type { BrowserTranscriptReference, SessionSummary } from '../../types/bridge';

const MAX_TITLE_LENGTH = 48;

export function studioComposerActions(
  streaming: boolean,
  hasContent: boolean,
): { showStop: boolean; showSend: boolean } {
  return {
    showStop: streaming,
    showSend: !streaming || hasContent,
  };
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

export function latestStudioSessionId(
  sessions: Iterable<Pick<SessionSummary, 'appSessionId' | 'cwd' | 'updatedAt' | 'sessionPurpose'>>,
  projectPaths: Iterable<string>,
): string | undefined {
  const paths = new Set([...projectPaths].filter(Boolean));
  let latest:
    | Pick<SessionSummary, 'appSessionId' | 'cwd' | 'updatedAt' | 'sessionPurpose'>
    | undefined;
  for (const session of sessions) {
    if (
      session.sessionPurpose !== 'design' ||
      !paths.has(session.cwd) ||
      (latest && latest.updatedAt >= session.updatedAt)
    ) {
      continue;
    }
    latest = session;
  }
  return latest?.appSessionId;
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
