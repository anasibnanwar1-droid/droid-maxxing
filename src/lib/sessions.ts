import type { ChildSessionSummary, SessionSummary } from '../types/bridge';
import { childSessionIsLive } from './childSessions';

// Phases where the session is waiting on the user (or finished) — never "working".
const INACTIVE = ['paused', 'completed', 'failed', 'awaiting_plan_approval', 'awaiting_run_start'];
// Phases that unambiguously mean a turn is in flight, used as a fallback for the
// brief window before the backend reports `streaming` over the bridge.
const CLEARLY_ACTIVE = ['planning', 'initializing', 'orchestrator_turn'];

// Whether a session is actively generating. Pure counterpart of the
// useSessionLive hook so non-React code can reuse the same rule.
export function sessionIsLive(session: Pick<SessionSummary, 'phase' | 'streaming'>): boolean {
  if (INACTIVE.includes(session.phase)) return false;
  if (session.streaming) return true;
  return CLEARLY_ACTIVE.includes(session.phase);
}

// The cwds of sessions that genuinely occupy a directory right now: the open
// draft, the active chat, any session with a live turn, and any session with a
// still-running child (children run in the parent session's cwd, so they pin it
// even when the primary session is idle). Historical/idle chats are excluded so
// cleaning up their old worktrees stays possible.
export function activeSessionCwds(opts: {
  sessions: SessionSummary[];
  activeAppSessionId: string | null;
  draftCwd?: string | null;
  childSessions?: Record<string, Record<string, Pick<ChildSessionSummary, 'status'>>>;
  childRuntime?: Record<string, Record<string, { available: boolean }>>;
  pinnedCwds?: Iterable<string>;
}): string[] {
  const cwds: string[] = [];
  if (opts.draftCwd) cwds.push(opts.draftCwd);
  if (opts.pinnedCwds) {
    for (const cwd of opts.pinnedCwds) if (cwd) cwds.push(cwd);
  }
  for (const m of opts.sessions) {
    if (!m.cwd) continue;
    const hasRunningChildSession = Object.entries(opts.childSessions?.[m.appSessionId] ?? {}).some(
      ([childSessionId, childSession]) =>
        childSessionIsLive(childSession, opts.childRuntime?.[m.appSessionId]?.[childSessionId]),
    );
    if (m.appSessionId === opts.activeAppSessionId || sessionIsLive(m) || hasRunningChildSession) {
      cwds.push(m.cwd);
    }
  }
  return cwds;
}
