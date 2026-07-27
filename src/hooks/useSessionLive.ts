import { sessionIsLive } from '../lib/sessions';
import { useStore } from './useStore';

/**
 * Whether a session is actively generating right now.
 *
 * The sidecar now reports an authoritative `streaming` flag that is true for the
 * whole turn (from send until the stream ends), so we no longer have to guess
 * from transcript freshness. We still respect phase for terminal/awaiting states.
 */
export function useSessionLive(appSessionId: string | null): boolean {
  const { state } = useStore();
  const session = appSessionId ? state.sessions[appSessionId] : null;
  return session ? sessionIsLive(session) : false;
}
