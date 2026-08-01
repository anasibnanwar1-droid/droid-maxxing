interface IsolatedWorkspaceIdentity {
  liveCwd: string;
  path: string;
}

export type StudioWorkspaceAccess =
  | { kind: 'empty' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; cwd: string };

export function canonicalLiveProjectCwd(
  cwd: string,
  workspaces: Iterable<IsolatedWorkspaceIdentity>,
): string {
  if (!cwd) return '';
  for (const workspace of workspaces) {
    if (workspace.path === cwd) return workspace.liveCwd;
  }
  return cwd;
}

export function studioRepositoryCwds(
  preferredCwd: string,
  workspaceCwds: Iterable<string>,
  workspaces: Iterable<IsolatedWorkspaceIdentity>,
): string[] {
  const knownWorkspaces = [...workspaces];
  const candidates = [preferredCwd, ...workspaceCwds].map((cwd) =>
    canonicalLiveProjectCwd(cwd, knownWorkspaces),
  );
  return candidates.filter(
    (candidate, index) => candidate !== '' && candidates.indexOf(candidate) === index,
  );
}

export function studioWorkspaceAccess(
  liveCwd: string,
  workspace: IsolatedWorkspaceIdentity | undefined,
  error: string | undefined,
): StudioWorkspaceAccess {
  if (!liveCwd) return { kind: 'empty' };
  if (workspace) return { kind: 'ready', cwd: workspace.path };
  if (error) return { kind: 'error', message: error };
  return { kind: 'loading' };
}
