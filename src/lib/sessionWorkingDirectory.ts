import type { TranscriptEvent } from '../types/bridge';
import type { GitWorktree } from '../types/vcs';
import { extractFileChange } from './diff';

const DIRECT_DIRECTORY_KEYS = new Set(['cwd', 'workdir', 'workingDirectory']);
const PATH_EVIDENCE_KEYS = new Set([
  'cmd',
  'command',
  'path',
  'file',
  'filePath',
  'file_path',
  'target_file',
]);

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

function pathContains(root: string, candidate: string): boolean {
  const normalizedRoot = normalizedPath(root);
  const normalizedCandidate = normalizedPath(candidate);
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function isPathReferenceBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s"'`=,:;()[\]{}|&]/.test(character);
}

function stringsForKeys(value: unknown, keys: Set<string>, output: string[] = []): string[] {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    for (const item of value) stringsForKeys(item, keys, output);
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && keys.has(key)) output.push(item);
    else if (item && typeof item === 'object') stringsForKeys(item, keys, output);
  }
  return output;
}

function referencedWorktree(evidence: string, worktrees: readonly string[]): string | undefined {
  const normalizedEvidence = normalizedPath(evidence);
  return worktrees.find((path) => {
    const normalizedWorktree = normalizedPath(path);
    let index = normalizedEvidence.indexOf(normalizedWorktree);
    while (index >= 0) {
      const before = normalizedEvidence[index - 1];
      const after = normalizedEvidence[index + normalizedWorktree.length];
      if (isPathReferenceBoundary(before) && (after === '/' || isPathReferenceBoundary(after))) {
        return true;
      }
      index = normalizedEvidence.indexOf(normalizedWorktree, index + normalizedWorktree.length);
    }
    return false;
  });
}

export function sessionWorkingDirectory(
  sessionCwd: string,
  transcript: readonly TranscriptEvent[],
  registeredWorktrees: readonly GitWorktree[],
): string {
  const worktrees = registeredWorktrees
    .flatMap((worktree) => (worktree.bare || !worktree.path ? [] : [worktree.path]))
    .sort((left, right) => {
      const leftIsSession = normalizedPath(left) === normalizedPath(sessionCwd);
      const rightIsSession = normalizedPath(right) === normalizedPath(sessionCwd);
      if (leftIsSession !== rightIsSession) return leftIsSession ? 1 : -1;
      return right.length - left.length;
    });
  if (worktrees.length === 0) return sessionCwd;

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const event = transcript[index];
    if (event.kind !== 'tool_call') continue;

    for (const directory of stringsForKeys(event.toolArgs, DIRECT_DIRECTORY_KEYS)) {
      const match = worktrees.find((path) => pathContains(path, directory));
      if (match) return match;
    }

    const change = extractFileChange(event.toolName, event.toolArgs);
    if (change) {
      const match = worktrees.find((path) => pathContains(path, change.path));
      if (match) return match;
    }

    for (const evidence of stringsForKeys(event.toolArgs, PATH_EVIDENCE_KEYS)) {
      const match = referencedWorktree(evidence, worktrees);
      if (match) return match;
    }
  }

  return sessionCwd;
}
