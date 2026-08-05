import { useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../types/bridge';
import { sessionWorkingDirectory } from '../lib/sessionWorkingDirectory';
import { useGitEnvironment } from './useGitEnvironment';
import { useStore } from './useStore';

export function useSessionWorkingDirectory(session: SessionSummary | null): string {
  const { state } = useStore();
  const sessionKey = session?.appSessionId ?? '';
  const sessionCwd = session?.cwd ?? '';
  const [discoveryTarget, setDiscoveryTarget] = useState({ sessionKey, cwd: sessionCwd });
  const discoveryCwd = discoveryTarget.sessionKey === sessionKey ? discoveryTarget.cwd : sessionCwd;
  const git = useGitEnvironment(discoveryCwd, 'worktree');
  const transcript = session ? (state.transcripts[session.appSessionId] ?? []) : [];

  const workingDirectory = useMemo(
    () => sessionWorkingDirectory(sessionCwd, transcript, git.worktrees),
    [git.worktrees, sessionCwd, transcript],
  );

  useEffect(() => {
    if (discoveryTarget.sessionKey !== sessionKey || discoveryTarget.cwd !== workingDirectory) {
      setDiscoveryTarget({ sessionKey, cwd: workingDirectory });
    }
  }, [discoveryTarget, sessionKey, workingDirectory]);

  return workingDirectory;
}
