import { isDesktop } from './desktop';
import type {
  CommitOptions,
  CreateBranchOptions,
  CreateWorktreeOptions,
  DiffFileList,
  DiffScope,
  DiffStatMode,
  FileDiffResult,
  GitActionResult,
  GitBranchList,
  GitDiffStat,
  GitEnvironment,
  GitWorktree,
  PushOptions,
} from '../types/vcs';

const NO_REPO: GitEnvironment = { isRepo: false };
const EMPTY_BRANCHES: GitBranchList = { current: null, detached: true, local: [], remote: [] };

export async function getGitEnvironment(dir: string): Promise<GitEnvironment> {
  if (!isDesktop() || !dir) return NO_REPO;
  try {
    return await window.droidControl!.gitEnvironment(dir);
  } catch {
    return NO_REPO;
  }
}

export async function getGitBranches(dir: string): Promise<GitBranchList> {
  if (!isDesktop() || !dir) return EMPTY_BRANCHES;
  try {
    return await window.droidControl!.gitBranches(dir);
  } catch {
    return EMPTY_BRANCHES;
  }
}

export async function getGitWorktrees(dir: string): Promise<GitWorktree[]> {
  if (!isDesktop() || !dir) return [];
  try {
    return await window.droidControl!.gitWorktrees(dir);
  } catch {
    return [];
  }
}

export async function getGitDiffStat(dir: string, mode: DiffStatMode): Promise<GitDiffStat | null> {
  if (!isDesktop() || !dir) return null;
  try {
    return await window.droidControl!.gitDiffStat(dir, { mode });
  } catch {
    return null;
  }
}

export async function getGitDiffFiles(
  dir: string,
  mode: DiffScope,
  sessionId?: string,
): Promise<DiffFileList> {
  if (!isDesktop() || !dir) return { mode, base: null, files: [] };
  try {
    return await window.droidControl!.gitDiffFiles(dir, { mode, sessionId });
  } catch {
    return { mode, base: null, files: [] };
  }
}

export async function getGitFileDiff(
  dir: string,
  mode: DiffScope,
  path: string,
  ignoreWhitespace = false,
  sessionId?: string,
): Promise<FileDiffResult> {
  if (!isDesktop() || !dir) return { path, diff: '', binary: false };
  try {
    return await window.droidControl!.gitFileDiff(dir, {
      mode,
      path,
      ignoreWhitespace,
      sessionId,
    });
  } catch {
    return { path, diff: '', binary: false };
  }
}

export async function markGitTurnStart(dir: string, sessionId?: string): Promise<void> {
  if (!isDesktop() || !dir) return;
  try {
    await window.droidControl!.gitMarkTurnStart(dir, sessionId);
  } catch {
    // best-effort baseline; the Last turn scope falls back to HEAD
  }
}

const failure = (reason: string): GitActionResult => ({ ok: false, reason });

export async function createGitBranch(
  dir: string,
  options: CreateBranchOptions,
): Promise<GitActionResult> {
  if (!isDesktop()) return failure('not_desktop');
  return window.droidControl!.gitCreateBranch(dir, options);
}

export async function checkoutGitBranch(
  dir: string,
  options: { ref: string; allowDirty?: boolean },
): Promise<GitActionResult> {
  if (!isDesktop()) return failure('not_desktop');
  return window.droidControl!.gitCheckout(dir, options);
}

export async function createGitWorktree(
  dir: string,
  options: CreateWorktreeOptions,
): Promise<GitActionResult> {
  if (!isDesktop()) return failure('not_desktop');
  return window.droidControl!.gitCreateWorktree(dir, options);
}

export async function removeGitWorktree(
  dir: string,
  options: { path: string; force?: boolean },
): Promise<GitActionResult> {
  if (!isDesktop()) return failure('not_desktop');
  return window.droidControl!.gitRemoveWorktree(dir, options);
}

export async function gitCommit(dir: string, options: CommitOptions): Promise<GitActionResult> {
  if (!isDesktop()) return failure('not_desktop');
  return window.droidControl!.gitCommit(dir, options);
}

export async function gitPush(dir: string, options: PushOptions): Promise<GitActionResult> {
  if (!isDesktop()) return failure('not_desktop');
  return window.droidControl!.gitPush(dir, options);
}

export async function gitFetch(dir: string): Promise<GitActionResult> {
  if (!isDesktop() || !dir) return failure('not_desktop');
  try {
    return await window.droidControl!.gitFetch(dir);
  } catch {
    return failure('git_error');
  }
}

// ---- Pure helpers (unit-tested) -------------------------------------------

export function diffModeLabel(mode: DiffStatMode, baseRef?: string | null): string {
  if (mode === 'branch') return `Branch vs ${baseRef || 'origin/main'}`;
  if (mode === 'uncommitted') return 'Uncommitted';
  return 'Worktree';
}

export const DIFF_MODES: DiffStatMode[] = ['worktree', 'branch', 'uncommitted'];

// Strip the leading "<remote>/" from a remote-tracking ref. Remote names can
// themselves contain "/", so match against the configured remotes and prefer
// the longest match rather than assuming the remote is the first path segment.
export function stripRemotePrefix(ref: string, remotes: string[] | undefined | null): string {
  const matched = (remotes ?? [])
    .filter((r) => ref === r || ref.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  return matched && ref.length > matched.length + 1 ? ref.slice(matched.length + 1) : ref;
}

// Describe the ref a branch/worktree was created from so the UI can show "main"
// with a local/remote badge regardless of the remote's name.
export function baseDescriptor(
  env: GitEnvironment | null,
): { ref: string; shortName: string; kind: 'local' | 'remote' } | null {
  if (!env?.base) return null;
  const kind = env.baseKind === 'remote' ? 'remote' : 'local';
  const shortName = kind === 'remote' ? stripRemotePrefix(env.base, env.remotes) : env.base;
  return { ref: env.base, shortName, kind };
}

export function worktreeName(worktree: Pick<GitWorktree, 'path' | 'branch'>): string {
  if (worktree.branch) return worktree.branch;
  const segments = (worktree.path ?? '').split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? 'worktree';
}

// Normalize a filesystem path for comparison: unify separators, collapse
// duplicate/trailing slashes, and fold case. Case folding errs toward treating
// paths as equal so the in-use guard never *under*-matches and exposes a remove
// action for a directory a session is actually running in.
function normalizePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// A worktree is "in use" when an active/live session runs in it (its cwd is the
// worktree root or a subdirectory). Removing such a worktree would delete that
// session's working directory out from under it.
export function isWorktreeInUse(worktreePath: string, sessionCwds: Iterable<string>): boolean {
  if (!worktreePath) return false;
  const root = normalizePath(worktreePath);
  if (!root) return false;
  const prefix = `${root}/`;
  for (const cwd of sessionCwds) {
    if (!cwd) continue;
    const normalized = normalizePath(cwd);
    if (normalized === root || normalized.startsWith(prefix)) return true;
  }
  return false;
}

export function aheadBehindLabel(ahead = 0, behind = 0): string | null {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.length ? parts.join(' ') : null;
}
