import type { GitActionResult } from '../types/vcs';

export interface WorktreeRemovalOutcome {
  result: GitActionResult;
  reanchored: number;
  reanchorFailed: boolean;
}

export async function removeWorktreeAndReanchor(
  remove: () => Promise<GitActionResult>,
  reanchor: () => Promise<number>,
): Promise<WorktreeRemovalOutcome> {
  const result = await remove();
  if (!result.ok) return { result, reanchored: 0, reanchorFailed: false };

  try {
    return { result, reanchored: await reanchor(), reanchorFailed: false };
  } catch {
    return { result, reanchored: 0, reanchorFailed: true };
  }
}
