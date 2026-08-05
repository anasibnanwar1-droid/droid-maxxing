import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../types/bridge';
import {
  sessionWorkingDirectoryForSource,
  workingDirectoryDuringDiscovery,
} from '../lib/sessionWorkingDirectory';
import { useGitEnvironment } from './useGitEnvironment';
import { useStore } from './useStore';

export function useSessionWorkingDirectory(
  session: SessionSummary | null,
  sourceSessionId?: string,
): string {
  const { state } = useStore();
  const sessionKey = session?.appSessionId ?? '';
  const sessionCwd = session?.cwd ?? '';
  const [discoveryTarget, setDiscoveryTarget] = useState({ sessionKey, cwd: sessionCwd });
  const discoveryCwd = discoveryTarget.sessionKey === sessionKey ? discoveryTarget.cwd : sessionCwd;
  const git = useGitEnvironment(discoveryCwd, 'worktree');
  const transcript = session ? (state.transcripts[session.appSessionId] ?? []) : [];

  const inferredDirectory = useMemo(
    () => sessionWorkingDirectoryForSource(sessionCwd, transcript, git.worktrees, sourceSessionId),
    [git.worktrees, sessionCwd, sourceSessionId, transcript],
  );
  // The migrated cwd has no cached snapshot on its first render. Keep it as
  // the authoritative discovery target until that initial load settles;
  // otherwise the empty worktree list would bounce us back to sessionCwd and
  // create a maximum-update-depth loop.
  const workingDirectory = workingDirectoryDuringDiscovery(
    sessionCwd,
    discoveryCwd,
    git.hasSnapshot,
    git.worktrees,
    inferredDirectory,
  );

  useEffect(() => {
    if (discoveryTarget.sessionKey !== sessionKey || discoveryTarget.cwd !== workingDirectory) {
      setDiscoveryTarget({ sessionKey, cwd: workingDirectory });
    }
  }, [discoveryTarget, sessionKey, workingDirectory]);

  return workingDirectory;
}
