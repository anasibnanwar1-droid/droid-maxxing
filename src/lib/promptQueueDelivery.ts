import type { QueuedPrompt } from '../hooks/useStore';
import type { TranscriptEvent } from '../types/bridge';
import type { SessionSummary } from '../types/bridge';
import { browserTranscriptReferencesFromDesignReferences } from '../components/browser/browserTranscriptReferences';
import { composePrompt } from './composePrompt';
import { createLocalDesignTranscriptEvent } from './promptQueue';
import { sessionIsLive } from './sessions';

export interface QueueDeliverySnapshot {
  sessions: Partial<Record<string, SessionSummary>>;
  promptQueue: Partial<Record<string, QueuedPrompt[]>>;
}

export interface PromptQueueDeliveryPort {
  snapshot: () => QueueDeliverySnapshot;
  markTurnStart: (cwd: string, appSessionId: string) => Promise<void>;
  sendDesign: (appSessionId: string, text: string, referenceIds: string[]) => void;
  sendSession: (appSessionId: string, text: string) => void;
  appendTranscript: (event: TranscriptEvent) => void;
  removePrompt: (appSessionId: string, id: string) => void;
  now?: () => number;
}

export function queuedSessionsThatSettled(
  previousLive: ReadonlyMap<string, boolean>,
  sessions: Record<string, SessionSummary>,
  promptQueue: Record<string, readonly unknown[] | undefined>,
): string[] {
  const settled: string[] = [];
  for (const session of Object.values(sessions)) {
    if (
      previousLive.get(session.appSessionId) === true &&
      !sessionIsLive(session) &&
      (promptQueue[session.appSessionId]?.length ?? 0) > 0
    ) {
      settled.push(session.appSessionId);
    }
  }
  return settled;
}

export function currentSessionLiveness(
  sessions: Record<string, SessionSummary>,
): Map<string, boolean> {
  return new Map(
    Object.values(sessions).map((session) => [session.appSessionId, sessionIsLive(session)]),
  );
}

export async function deliverQueuedPrompt(
  appSessionId: string,
  port: PromptQueueDeliveryPort,
): Promise<boolean> {
  const captured = port.snapshot().sessions[appSessionId];
  if (!captured) return false;
  if (captured.cwd) await port.markTurnStart(captured.cwd, appSessionId);

  const current = port.snapshot();
  const session = current.sessions[appSessionId];
  if (!session || sessionIsLive(session)) return false;
  const head: QueuedPrompt | undefined = current.promptQueue[appSessionId]?.[0];
  if (!head) return false;

  if (head.design) {
    port.sendDesign(head.design.browserKey, head.text, head.design.referenceIds);
    port.appendTranscript(
      createLocalDesignTranscriptEvent(
        appSessionId,
        head.text,
        browserTranscriptReferencesFromDesignReferences(head.design.references),
      ),
    );
  } else if (head.studio) {
    port.sendSession(appSessionId, head.studio.prompt);
    port.appendTranscript(
      createLocalDesignTranscriptEvent(appSessionId, head.text, head.studio.browserRefs ?? []),
    );
  } else {
    const now = port.now?.() ?? Date.now();
    port.sendSession(appSessionId, composePrompt(head.text, head.skills, head.files));
    port.appendTranscript({
      id: `local-${String(now)}`,
      appSessionId,
      sourceSessionId: 'user',
      role: 'primary',
      ts: now,
      kind: 'text',
      text: head.text,
      author: 'user',
      skills: head.skills,
      files: head.files,
    });
  }

  port.removePrompt(appSessionId, head.id);
  return true;
}
