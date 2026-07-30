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
  return { id: `project-${digest}`, canonicalRoot, kind };
}

function gitCommonDir(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--git-common-dir'], {
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
