import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitCommitResult {
  ok: boolean;
  sha?: string;
  error?: string;
}

export async function commitDesignChange(cwd: string, message: string): Promise<GitCommitResult> {
  const trimmed = message.trim().slice(0, 200);
  if (!trimmed) return { ok: false, error: 'Commit message is empty.' };
  try {
    const { stdout: status } = await git(cwd, ['status', '--porcelain']);
    if (!status.trim()) return { ok: false, error: 'Nothing to commit.' };
    await git(cwd, ['add', '-A']);
    await git(cwd, ['commit', '-m', trimmed]);
    const { stdout: sha } = await git(cwd, ['rev-parse', 'HEAD']);
    return { ok: true, sha: sha.trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Git commit failed.' };
  }
}

function git(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return execFileAsync('git', args, { cwd, timeout: 15_000 });
}
