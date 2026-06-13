import type { BrowserTranscriptReference, TranscriptEvent } from '../types/bridge';

export const newQueueId = () => `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export function createLocalDesignTranscriptEvent(
  missionId: string,
  text: string,
  browserRefs: BrowserTranscriptReference[],
): TranscriptEvent {
  return {
    id: `local-design-${Date.now()}`,
    missionId,
    agentSessionId: 'user',
    role: 'orchestrator',
    ts: Date.now(),
    kind: 'text',
    text,
    author: 'user',
    browserRefs: browserRefs.length ? browserRefs : undefined,
  };
}
