import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEvent } from '../types/bridge';
import type { GitWorktree } from '../types/vcs';
import {
  sessionWorkingDirectory,
  sessionWorkingDirectoryForSource,
  workingDirectoryDuringDiscovery,
} from './sessionWorkingDirectory';

const main = '/Users/test/droid-control';
const linked = '/Users/test/droid-control-review';
const worktrees: GitWorktree[] = [
  {
    path: main,
    head: 'main-head',
    branch: 'main',
    bare: false,
    detached: false,
    locked: false,
    isMain: true,
    isCurrent: true,
  },
  {
    path: linked,
    head: 'review-head',
    branch: 'feat/review-panel-file-focus',
    bare: false,
    detached: false,
    locked: false,
    isMain: false,
    isCurrent: false,
  },
];

function tool(id: string, toolName: string, toolArgs: unknown): TranscriptEvent {
  return {
    id,
    appSessionId: 'session-1',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: Number(id),
    kind: 'tool_call',
    toolName,
    toolArgs,
  };
}

test('uses a linked worktree named in an execution working directory', () => {
  const transcript = [
    tool('1', 'exec_command', {
      cmd: 'git status --short',
      workdir: linked,
    }),
  ];

  assert.equal(sessionWorkingDirectory(main, transcript, worktrees), linked);
});

test('detects the worktree created by a git worktree command', () => {
  const transcript = [
    tool('1', 'exec_command', {
      cmd: `git -C ${main} worktree add ${linked} -b feat/review-panel-file-focus`,
    }),
  ];

  assert.equal(sessionWorkingDirectory(main, transcript, worktrees), linked);
});

test('does not treat a sibling path sharing a worktree prefix as worktree evidence', () => {
  const transcript = [
    tool('1', 'exec_command', {
      cmd: `git -C ${linked}-archive status --short`,
    }),
  ];

  assert.equal(sessionWorkingDirectory(main, transcript, worktrees), main);
});

test('uses an absolute edited file as worktree evidence', () => {
  const transcript = [
    tool('1', 'write_file', {
      file_path: `${linked}/src/components/ReviewPanel.tsx`,
      content: 'export {}',
    }),
  ];

  assert.equal(sessionWorkingDirectory(main, transcript, worktrees), linked);
});

test('ignores assistant prose and unregistered directories', () => {
  const transcript: TranscriptEvent[] = [
    {
      id: '1',
      appSessionId: 'session-1',
      sourceSessionId: 'primary',
      role: 'primary',
      ts: 1,
      kind: 'text',
      text: `I worked in ${linked}`,
    },
    tool('2', 'exec_command', { workdir: '/tmp/unregistered', cmd: 'git status' }),
  ];

  assert.equal(sessionWorkingDirectory(main, transcript, worktrees), main);
});

test('scopes worktree evidence to the visible child session', () => {
  const primary = tool('1', 'exec_command', { cwd: main, cmd: 'git status' });
  const child = {
    ...tool('2', 'exec_command', { cwd: linked, cmd: 'git status' }),
    sourceSessionId: 'worker-1',
    role: 'worker' as const,
  };

  assert.equal(
    sessionWorkingDirectoryForSource(main, [primary, child], worktrees, 'worker-1'),
    linked,
  );
  assert.equal(sessionWorkingDirectoryForSource(main, [primary, child], worktrees), main);
});

test('retains a migrated worktree until its discovery snapshot loads', () => {
  assert.equal(workingDirectoryDuringDiscovery(main, linked, false, [], main), linked);
  assert.equal(workingDirectoryDuringDiscovery(main, linked, true, [], main), linked);
  assert.equal(workingDirectoryDuringDiscovery(main, linked, true, worktrees, linked), linked);
});

test('resolves relative edits against the latest tool worktree', () => {
  const transcript = [
    tool('1', 'exec_command', { cwd: linked, cmd: 'git status' }),
    tool('2', 'write_file', { file_path: 'src/app.ts', content: 'export {}' }),
  ];

  assert.equal(sessionWorkingDirectory(main, transcript, worktrees), linked);
});

test('canonicalizes parent segments before matching a sibling worktree', () => {
  const sibling = '/Users/test/droid-control-sibling';
  const registered = [...worktrees, { ...worktrees[1], path: sibling, branch: 'feat/sibling' }];
  const transcript = [
    tool('1', 'exec_command', { cwd: linked, cmd: 'git status' }),
    tool('2', 'write_file', {
      file_path: `../${sibling.split('/').at(-1)}/src/app.ts`,
      content: 'export {}',
    }),
  ];

  assert.equal(sessionWorkingDirectory(main, transcript, registered), sibling);
});

test('resolves relative edits against the latest tool subdirectory', () => {
  const sibling = '/Users/test/droid-control-sibling';
  const registered = [...worktrees, { ...worktrees[1], path: sibling, branch: 'feat/sibling' }];
  const transcript = [
    tool('1', 'exec_command', { cwd: `${linked}/packages/web`, cmd: 'git status' }),
    tool('2', 'write_file', {
      file_path: '../../../droid-control-sibling/src/app.ts',
      content: 'export {}',
    }),
  ];

  assert.equal(sessionWorkingDirectory(main, transcript, registered), sibling);
});

test('matches Windows worktree paths without case sensitivity', () => {
  const windowsWorktree: GitWorktree = {
    ...worktrees[0],
    path: 'C:\\Users\\Test\\Droid-Control',
  };
  const transcript = [
    tool('1', 'exec_command', {
      cwd: 'c:\\users\\test\\droid-control',
      cmd: 'git status',
    }),
  ];

  assert.equal(
    sessionWorkingDirectory('C:\\Users\\Test\\Other', transcript, [windowsWorktree]),
    windowsWorktree.path,
  );
});
