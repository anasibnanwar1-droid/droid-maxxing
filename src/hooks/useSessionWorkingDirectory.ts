import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../types/bridge';
import {
  sessionWorkingDirectoryForSource,
  worktreeDiscoveryRevision,
  workingDirectoryDuringDiscovery,
} from '../lib/sessionWorkingDirectory';
import { getGitWorktrees } from '../lib/git';
import type { GitWorktree } from '../types/vcs';
import { useDocumentVisible } from './useDocumentVisible';
import { useStore } from './useStore';

interface WorktreeSnapshot {
  sessionKey: string;
  cwd: string;
  revision: string;
  worktrees: GitWorktree[];
  discoveredAt: number;
}

const EMPTY_DISCOVERY_RETRY_MS = 5_000;

// A worktree discovery is only "settled" once it returned at least one
// worktree. getGitWorktrees resolves to [] both for a genuine empty repo and
// for a transient Git/IPC failure (sidecar IPC not booted yet, a crashed git
// call), so empty results are retried after a short cooldown. This avoids
// spawning Git on every tool result in a genuine non-repository while still
// letting a transient first probe recover on a later revision or visibility
// change.
export function isWorktreeDiscoveryStable(
  snapshot: WorktreeSnapshot | null,
  sessionKey: string,
  cwd: string,
  revision: string,
  now = Date.now(),
): boolean {
  if (!snapshot) return false;
  if (snapshot.sessionKey !== sessionKey || snapshot.cwd !== cwd) return false;
  if (snapshot.worktrees.length === 0) {
    return now - snapshot.discoveredAt < EMPTY_DISCOVERY_RETRY_MS;
  }
  return snapshot.revision === revision;
}

export function useSessionWorkingDirectory(
  session: SessionSummary | null,
  sourceSessionId?: string,
): string {
  const { state } = useStore();
  const sessionKey = session?.appSessionId ?? '';
  const sessionCwd = session?.cwd ?? '';
  const [discoveryTarget, setDiscoveryTarget] = useState({ sessionKey, cwd: sessionCwd });
  const discoveryCwd = discoveryTarget.sessionKey === sessionKey ? discoveryTarget.cwd : sessionCwd;
  const transcript = session ? (state.transcripts[session.appSessionId] ?? []) : [];
  const revision = useMemo(
    () => worktreeDiscoveryRevision(transcript, sourceSessionId),
    [sourceSessionId, transcript],
  );
  const visible = useDocumentVisible();
  const [snapshot, setSnapshot] = useState<WorktreeSnapshot | null>(null);
  const hasSnapshot =
    snapshot?.sessionKey === sessionKey &&
    snapshot.cwd === discoveryCwd &&
    snapshot.revision === revision;
  const worktrees = hasSnapshot ? snapshot.worktrees : [];
  // Empty discoveries block re-probing only during their cooldown; after it
  // expires, a visibility or transcript revision change retries the probe.
  const discoveryStable = isWorktreeDiscoveryStable(snapshot, sessionKey, discoveryCwd, revision);

  const inferredDirectory = useMemo(
    () => sessionWorkingDirectoryForSource(sessionCwd, transcript, worktrees, sourceSessionId),
    [sessionCwd, sourceSessionId, transcript, worktrees],
  );
  // The migrated cwd has no cached snapshot on its first render. Keep it as
  // the authoritative discovery target until that initial load settles;
  // otherwise the empty worktree list would bounce us back to sessionCwd and
  // create a maximum-update-depth loop.
  const workingDirectory = workingDirectoryDuringDiscovery(
    sessionCwd,
    discoveryCwd,
    hasSnapshot,
    worktrees,
    inferredDirectory,
  );

  useEffect(() => {
    if (!visible || !sessionKey || !discoveryCwd || discoveryStable) return;
    let cancelled = false;
    void getGitWorktrees(discoveryCwd).then((nextWorktrees) => {
      if (cancelled) return;
      setSnapshot({
        sessionKey,
        cwd: discoveryCwd,
        revision,
        worktrees: nextWorktrees,
        discoveredAt: Date.now(),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [discoveryCwd, discoveryStable, revision, sessionKey, visible]);

  useEffect(() => {
    if (discoveryTarget.sessionKey !== sessionKey || discoveryTarget.cwd !== workingDirectory) {
      setDiscoveryTarget({ sessionKey, cwd: workingDirectory });
    }
  }, [discoveryTarget, sessionKey, workingDirectory]);

  return workingDirectory;
}
