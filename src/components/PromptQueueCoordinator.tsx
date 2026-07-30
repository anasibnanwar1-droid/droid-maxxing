import { useEffect, useRef } from 'react';
import { useStore } from '../hooks/useStore';
import { sendDesignPrompt, sendToSession } from '../lib/commands';
import { markGitTurnStart } from '../lib/git';
import {
  currentSessionLiveness,
  deliverQueuedPrompt,
  queuedSessionsThatSettled,
} from '../lib/promptQueueDelivery';

/**
 * The single app-level owner for staged prompt delivery. It follows every
 * session by stable id, so a Studio history thread can settle independently of
 * whichever chat happens to be visible in the main shell.
 */
export default function PromptQueueCoordinator() {
  const { state, dispatch } = useStore();
  const stateRef = useRef(state);
  stateRef.current = state;
  const previousLiveRef = useRef(currentSessionLiveness(state.sessions));
  const deliveringRef = useRef(new Set<string>());

  useEffect(() => {
    const settled = queuedSessionsThatSettled(
      previousLiveRef.current,
      state.sessions,
      state.promptQueue,
    );
    previousLiveRef.current = currentSessionLiveness(state.sessions);
    for (const appSessionId of settled) {
      void deliver(appSessionId);
    }
    // Delivery reads the latest queue through stateRef after the git baseline.
    // Queue edits alone must not create a synthetic live-to-idle transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sessions]);

  const deliver = async (appSessionId: string) => {
    if (deliveringRef.current.has(appSessionId)) return;
    deliveringRef.current.add(appSessionId);
    try {
      await deliverQueuedPrompt(appSessionId, {
        snapshot: () => stateRef.current,
        markTurnStart: (cwd, sessionId) => markGitTurnStart(cwd, sessionId),
        sendDesign: sendDesignPrompt,
        sendSession: sendToSession,
        appendTranscript: (event) => {
          dispatch({ type: 'SESSION_TRANSCRIPT', event });
        },
        removePrompt: (sessionId, id) => {
          dispatch({ type: 'REMOVE_QUEUED_PROMPT', appSessionId: sessionId, id });
        },
      });
    } catch (error) {
      console.error('[PromptQueueCoordinator] queued send failed:', error);
    } finally {
      deliveringRef.current.delete(appSessionId);
    }
  };

  return null;
}
