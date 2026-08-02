import { useStore } from '../hooks/useStore';
import type { ContextStatsSnapshot } from '../types/bridge';
import ContextMeter from './ContextMeter';

// Compact context/status cluster for the prompt-input toolbar: a queued-send
// badge plus the context-usage meter (a ring; its hover tooltip carries the
// compaction count and window size, and clicking opens the full breakdown).
// Extracted from the old full-width bottom status strip so the app shell can
// stretch to the bottom edge while this stays tucked in a corner of the composer.
export default function ContextStatusCluster() {
  const { state } = useStore();
  const session = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  const selectedChild =
    state.selectedChild?.parentAppSessionId === session?.appSessionId ? state.selectedChild : null;
  // Explicit `| undefined` on the parent entry avoids a false positive from
  // @typescript-eslint/no-unnecessary-condition: Record<string, T> indexing
  // returns T (not T | undefined) in TypeScript, but the key may be absent at
  // runtime, so the optional chain on childParent is semantically necessary.
  const childParent: Record<string, ContextStatsSnapshot> | undefined = selectedChild
    ? state.contextStats.child[selectedChild.parentAppSessionId]
    : undefined;
  const primaryStats = session ? state.contextStats.primary[session.appSessionId] : undefined;
  const contextStats = selectedChild ? childParent?.[selectedChild.childSessionId] : primaryStats;
  const contextSessionSummary =
    session && selectedChild && !contextStats
      ? {
          ...session,
          contextTokens: 0,
          contextRemainingTokens: undefined,
          contextAccuracy: undefined,
          contextUpdatedAt: undefined,
          maxContextTokens: undefined,
        }
      : session;
  if (!contextSessionSummary) return null;

  return (
    <div className="flex shrink-0 items-center gap-2">
      {session?.queuedSends ? (
        <span className="rounded-md border border-droid-border bg-droid-elevated/70 px-1.5 py-0.5 font-mono text-[10px] text-droid-text-secondary">
          {session.queuedSends} queued
        </span>
      ) : null}
      <ContextMeter
        session={contextSessionSummary}
        stats={contextStats}
        sessionKey={
          selectedChild
            ? `${selectedChild.parentAppSessionId}:${selectedChild.childSessionId}`
            : contextSessionSummary.appSessionId
        }
        isChild={!!selectedChild}
      />
    </div>
  );
}
