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
    if (!visible || !sessionKey || !discoveryCwd || hasSnapshot) return;
    let cancelled = false;
    void getGitWorktrees(discoveryCwd).then((nextWorktrees) => {
      if (cancelled) return;
      setSnapshot({
        sessionKey,
        cwd: discoveryCwd,
        revision,
        worktrees: nextWorktrees,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [discoveryCwd, hasSnapshot, revision, sessionKey, visible]);

  useEffect(() => {
    if (discoveryTarget.sessionKey !== sessionKey || discoveryTarget.cwd !== workingDirectory) {
      setDiscoveryTarget({ sessionKey, cwd: workingDirectory });
    }
  }, [discoveryTarget, sessionKey, workingDirectory]);

  return workingDirectory;
}
