import { useMemo } from 'react';
import type { SessionSummary } from '../types/bridge';
import { sessionWorkingDirectory } from '../lib/sessionWorkingDirectory';
import { useGitEnvironment } from './useGitEnvironment';
import { useStore } from './useStore';

export function useSessionWorkingDirectory(session: SessionSummary | null): string {
  const { state } = useStore();
  const sessionCwd = session?.cwd ?? '';
  const git = useGitEnvironment(sessionCwd, 'worktree');
  const transcript = session ? (state.transcripts[session.appSessionId] ?? []) : [];

  return useMemo(
    () => sessionWorkingDirectory(sessionCwd, transcript, git.worktrees),
    [git.worktrees, sessionCwd, transcript],
  );
}
