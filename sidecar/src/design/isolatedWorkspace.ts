import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Where the design agent actually works. When the project is a git repo we run
 * the whole design session — and every DNA/prototype/commit write — inside a
 * linked worktree on a dedicated `droidex/design` branch, so design work never
 * touches the live tree the user's dev server is watching (this was also a
 * contributor to the CPU/wakeup storm) and the user reviews + merges when happy.
 * Isolation failures are fatal: Studio never falls back to the live checkout.
 */
export interface WorkspaceInfo {
  liveCwd: string;
  path: string;
  isWorktree: boolean;
  branch?: string;
  note?: string;
}

const BRANCH = 'droidex/design';
const DIRNAME = 'droidex-design';
// DNA files worth carrying from the live tree into a freshly created worktree so
// the studio shows continuity (uncommitted DESIGN.md/MOTION.md aren't in HEAD).
const SEED_FILES = ['DESIGN.md', 'MOTION.md'];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000 });
  return stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

interface WorktreeRecord {
  path: string;
  branch?: string;
}

function parseWorktrees(porcelain: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line.trim() === '' && current) {
      records.push(current);
      current = null;
    }
  }
  if (current) records.push(current);
  return records;
}

export async function prepareDesignWorkspace(liveCwd: string): Promise<WorkspaceInfo> {
  const repoRoot = (await tryGit(liveCwd, ['rev-parse', '--show-toplevel']))?.trim();
  if (!repoRoot) {
    throw new Error(
      'DROIDEX Design requires a Git repository so it can create an isolated worktree. Initialize Git and commit the project before opening Studio.',
    );
  }

  const worktreePath = join(repoRoot, '.worktrees', DIRNAME);
  const branchRef = `refs/heads/${BRANCH}`;

  // Reuse the worktree at our path, or wherever the design branch is already checked out.
  const records = parseWorktrees(
    (await tryGit(repoRoot, ['worktree', 'list', '--porcelain'])) ?? '',
  );
  const existing = records.find((r) => r.path === worktreePath || r.branch === branchRef);
  if (existing && existsSync(existing.path)) {
    return { liveCwd, path: existing.path, isWorktree: true, branch: BRANCH };
  }

  try {
    await ensureWorktreesIgnored(repoRoot);
    await mkdir(join(repoRoot, '.worktrees'), { recursive: true });
    const branchExists =
      (await tryGit(repoRoot, ['show-ref', '--verify', '--quiet', branchRef])) !== null;
    const args = branchExists
      ? ['worktree', 'add', worktreePath, BRANCH]
      : ['worktree', 'add', '-b', BRANCH, worktreePath, 'HEAD'];
    await git(repoRoot, args);
    await seedDna(liveCwd, worktreePath);
    return { liveCwd, path: worktreePath, isWorktree: true, branch: BRANCH };
  } catch (error) {
    throw new Error(
      `Could not create the isolated DROIDEX Design worktree: ${firstLine(error)}. Resolve the Git worktree error and retry; the live checkout was not opened for design work.`,
    );
  }
}

// Keep `.worktrees/` out of `git status` via the repo-local exclude file (not a
// tracked .gitignore), so isolation never dirties the user's repo.
async function ensureWorktreesIgnored(repoRoot: string): Promise<void> {
  const commonDir = (await tryGit(repoRoot, ['rev-parse', '--git-common-dir']))?.trim();
  if (!commonDir) return;
  const gitDir = isAbsolute(commonDir) ? commonDir : join(repoRoot, commonDir);
  const excludePath = join(gitDir, 'info', 'exclude');
  try {
    const current = existsSync(excludePath) ? await readFile(excludePath, 'utf8') : '';
    if (
      current
        .split('\n')
        .some((line) => line.trim() === '/.worktrees/' || line.trim() === '.worktrees/')
    ) {
      return;
    }
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    await appendFile(excludePath, `${prefix}/.worktrees/\n`);
  } catch {
    // Best-effort; a missing exclude file just means the dir may show as untracked.
  }
}

async function seedDna(liveCwd: string, worktreePath: string): Promise<void> {
  for (const name of SEED_FILES) {
    const src = join(liveCwd, name);
    if (!existsSync(src)) continue;
    try {
      await copyFile(src, join(worktreePath, name));
    } catch {
      // Best-effort continuity; not fatal.
    }
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 120);
}
