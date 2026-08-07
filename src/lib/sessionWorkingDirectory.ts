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
  const slashed = path.replaceAll('\\', '/');
  const drive = /^[a-z]:/i.exec(slashed)?.[0] ?? '';
  const absolute = slashed.startsWith('/') || drive.length > 0;
  const body = drive ? slashed.slice(drive.length).replace(/^\//, '') : slashed.replace(/^\//, '');
  const segments = normalizedSegments(body, absolute);
  let prefix = '';
  if (drive) prefix = `${drive}/`;
  else if (absolute) prefix = '/';
  return `${prefix}${segments.join('/')}` || (absolute ? prefix : '.');
}

function normalizedSegments(path: string, absolute: boolean): string[] {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') segments.pop();
      else if (!absolute) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

function isCaseInsensitivePath(path: string): boolean {
  if (/^[a-z]:\//i.test(path)) return true;
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad|ipod|windows/i.test(navigator.userAgent);
}

function comparablePath(path: string): string {
  const normalized = normalizedPath(path);
  return isCaseInsensitivePath(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function pathContains(root: string, candidate: string): boolean {
  const normalizedRoot = comparablePath(root);
  const normalizedCandidate = comparablePath(candidate);
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function isAbsolutePath(path: string): boolean {
  const normalized = normalizedPath(path);
  return normalized.startsWith('/') || /^[a-z]:\//i.test(normalized);
}

function resolveToolPath(path: string, cwd: string): string {
  if (isAbsolutePath(path)) return path;
  return `${normalizedPath(cwd)}/${path.replace(/^\.\//, '')}`;
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
  const normalizedEvidence = comparablePath(evidence);
  return worktrees.find((path) => {
    const normalizedWorktree = comparablePath(path);
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
      const leftIsSession = comparablePath(left) === comparablePath(sessionCwd);
      const rightIsSession = comparablePath(right) === comparablePath(sessionCwd);
      if (leftIsSession !== rightIsSession) return leftIsSession ? 1 : -1;
      return right.length - left.length;
    });
  if (worktrees.length === 0) return sessionCwd;

  let workingDirectory = sessionCwd;
  let latestToolCwd = sessionCwd;
  for (const event of transcript) {
    if (event.kind !== 'tool_call') continue;

    for (const directory of stringsForKeys(event.toolArgs, DIRECT_DIRECTORY_KEYS)) {
      const match = worktrees.find((path) => pathContains(path, directory));
      if (match) {
        latestToolCwd = directory;
        workingDirectory = match;
      }
    }

    const change = extractFileChange(event.toolName, event.toolArgs);
    if (change) {
      const resolvedPath = resolveToolPath(change.path, latestToolCwd);
      const match = worktrees.find((path) => pathContains(path, resolvedPath));
      if (match) workingDirectory = match;
    }

    for (const evidence of stringsForKeys(event.toolArgs, PATH_EVIDENCE_KEYS)) {
      const match = referencedWorktree(evidence, worktrees);
      if (match) workingDirectory = match;
    }
  }

  return workingDirectory;
}

export function sessionWorkingDirectoryForSource(
  sessionCwd: string,
  transcript: readonly TranscriptEvent[],
  registeredWorktrees: readonly GitWorktree[],
  sourceSessionId?: string,
): string {
  const scopedTranscript = sourceSessionId
    ? transcript.filter((event) => event.sourceSessionId === sourceSessionId)
    : transcript.filter((event) => event.role === 'primary');
  return sessionWorkingDirectory(sessionCwd, scopedTranscript, registeredWorktrees);
}

export function worktreeDiscoveryRevision(
  transcript: readonly TranscriptEvent[],
  sourceSessionId?: string,
): string {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const event = transcript[index];
    if (event.kind !== 'tool_result') continue;
    if (sourceSessionId ? event.sourceSessionId === sourceSessionId : event.role === 'primary') {
      return event.id;
    }
  }
  return '';
}

export function workingDirectoryDuringDiscovery(
  sessionCwd: string,
  discoveryCwd: string,
  hasDiscoverySnapshot: boolean,
  registeredWorktrees: readonly GitWorktree[],
  inferredDirectory: string,
): string {
  const migratedTargetConfirmed = registeredWorktrees.some(
    (worktree) =>
      worktree.path !== null && comparablePath(worktree.path) === comparablePath(discoveryCwd),
  );
  return discoveryCwd !== sessionCwd && (!hasDiscoverySnapshot || !migratedTargetConfirmed)
    ? discoveryCwd
    : inferredDirectory;
}
