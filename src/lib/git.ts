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

export async function getGitDiffFiles(dir: string, mode: DiffScope): Promise<DiffFileList> {
  if (!isDesktop() || !dir) return { mode, base: null, files: [] };
  try {
    return await window.droidControl!.gitDiffFiles(dir, { mode });
  } catch {
    return { mode, base: null, files: [] };
  }
}

export async function getGitFileDiff(
  dir: string,
  mode: DiffScope,
  path: string,
  ignoreWhitespace = false,
): Promise<FileDiffResult> {
  if (!isDesktop() || !dir) return { path, diff: '', binary: false };
  try {
    return await window.droidControl!.gitFileDiff(dir, { mode, path, ignoreWhitespace });
  } catch {
    return { path, diff: '', binary: false };
  }
}

export async function markGitTurnStart(dir: string): Promise<void> {
  if (!isDesktop() || !dir) return;
  try {
    await window.droidControl!.gitMarkTurnStart(dir);
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

// ---- Pure helpers (unit-tested) -------------------------------------------

export function diffModeLabel(mode: DiffStatMode, defaultBranch?: string | null): string {
  if (mode === 'branch') return `Branch vs origin/${defaultBranch || 'main'}`;
  if (mode === 'uncommitted') return 'Uncommitted';
  return 'Worktree';
}

export const DIFF_MODES: DiffStatMode[] = ['worktree', 'branch', 'uncommitted'];

// Describe the ref a branch/worktree was created from so the UI can show "main"
// with a local/remote badge regardless of the remote's name.
export function baseDescriptor(
  env: GitEnvironment | null,
): { ref: string; shortName: string; kind: 'local' | 'remote' } | null {
  if (!env?.base) return null;
  const kind = env.baseKind === 'remote' ? 'remote' : 'local';
  const shortName =
    kind === 'remote' ? env.base.split('/').slice(1).join('/') || env.base : env.base;
  return { ref: env.base, shortName, kind };
}

export function worktreeName(worktree: Pick<GitWorktree, 'path' | 'branch'>): string {
  if (worktree.branch) return worktree.branch;
  const segments = (worktree.path ?? '').split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? 'worktree';
}

export function aheadBehindLabel(ahead = 0, behind = 0): string | null {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.length ? parts.join(' ') : null;
}

// A live session must never hop worktrees (it would desync the agent's cwd).
// Returns the reason switching is blocked, or null when it is allowed.
export function worktreeSwitchBlockReason(opts: { hasActiveSession: boolean }): string | null {
  return opts.hasActiveSession ? 'active_session' : null;
}

// Guard an in-place branch checkout: blocked while the agent is working or the
// tree is dirty (the caller may re-run with allowDirty after confirmation).
export function checkoutBlockReason(opts: {
  live: boolean;
  dirty: boolean;
}): 'live' | 'dirty' | null {
  if (opts.live) return 'live';
  if (opts.dirty) return 'dirty';
  return null;
}
