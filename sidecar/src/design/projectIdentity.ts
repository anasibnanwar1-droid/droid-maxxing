import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface DesignProjectIdentity {
  id: string;
  canonicalRoot: string;
  kind: 'git' | 'directory';
}

/**
 * Resolve one identity for a repository and all of its linked worktrees.
 * Non-git folders use their canonical filesystem path.
 */
export function resolveDesignProjectIdentity(cwd: string): DesignProjectIdentity {
  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync(cwd);
  } catch (error) {
    throw new Error(`Could not resolve design project folder ${cwd}: ${messageOf(error)}`, {
      cause: error,
    });
  }

  const commonDir = gitCommonDir(canonicalCwd);
  const kind = commonDir ? 'git' : 'directory';
  let canonicalRoot = canonicalCwd;
  if (commonDir) {
    const candidate = isAbsolute(commonDir) ? commonDir : resolve(canonicalCwd, commonDir);
    try {
      canonicalRoot = realpathSync(candidate);
    } catch (error) {
      throw new Error(`Could not resolve git common directory ${candidate}: ${messageOf(error)}`, {
        cause: error,
      });
    }
  }

  const digest = createHash('sha256').update(`${kind}:${canonicalRoot}`).digest('hex').slice(0, 24);
  const pathIdentity = `project-${digest}`;
  const id = commonDir ? stableGitIdentity(canonicalCwd, pathIdentity) : pathIdentity;
  return { id, canonicalRoot, kind };
}

function stableGitIdentity(cwd: string, initialIdentity: string): string {
  const existing = git(cwd, ['config', '--local', '--get', 'droidex.projectId']);
  if (existing && /^project-[a-f\d]{24}$/.test(existing)) return existing;
  try {
    execFileSync('git', ['config', '--local', 'droidex.projectId', initialIdentity], {
      cwd,
      stdio: 'ignore',
      timeout: 10_000,
    });
    return initialIdentity;
  } catch (error) {
    throw new Error(`Could not persist the design project identity: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

function gitCommonDir(cwd: string): string | undefined {
  return git(cwd, ['rev-parse', '--git-common-dir']);
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
