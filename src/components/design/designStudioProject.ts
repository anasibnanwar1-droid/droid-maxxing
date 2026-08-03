interface IsolatedWorkspaceIdentity {
  liveCwd: string;
  path: string;
}

interface GitWorktreeIdentity {
  path: string | null;
  branch: string | null;
  isMain: boolean;
  isCurrent: boolean;
}

type LoadGitWorktrees = (cwd: string) => Promise<GitWorktreeIdentity[]>;

const DESIGN_BRANCH = 'droidex/design';

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
  const knownCwd = knownLiveProjectCwd(cwd, workspaces);
  if (knownCwd) return knownCwd;
  const normalized = cwd.replaceAll('\\', '/');
  const isolatedSuffix = '/.worktrees/droidex-design';
  if (normalized.endsWith(isolatedSuffix)) {
    return cwd.slice(0, cwd.length - isolatedSuffix.length);
  }
  return cwd;
}

export async function recoverLiveProjectCwd(
  cwd: string,
  workspaces: Iterable<IsolatedWorkspaceIdentity>,
  loadGitWorktrees: LoadGitWorktrees,
): Promise<string> {
  if (!cwd) return '';
  const knownCwd = knownLiveProjectCwd(cwd, workspaces);
  if (knownCwd) return knownCwd;

  const gitWorktrees = await loadGitWorktrees(cwd);
  const current = gitWorktrees.find((worktree) => worktree.isCurrent);
  if (current?.branch === DESIGN_BRANCH) {
    const main = gitWorktrees.find((worktree) => worktree.isMain && worktree.path);
    if (main?.path) return main.path;
  }

  return canonicalLiveProjectCwd(cwd, []);
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

export function knownLiveProjectCwd(
  cwd: string,
  workspaces: Iterable<IsolatedWorkspaceIdentity>,
): string | undefined {
  for (const workspace of workspaces) {
    if (workspace.path === cwd) return workspace.liveCwd;
    if (workspace.liveCwd === cwd) return cwd;
  }
  return undefined;
}
