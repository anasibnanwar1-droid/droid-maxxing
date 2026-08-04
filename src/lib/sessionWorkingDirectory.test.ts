import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEvent } from '../types/bridge';
import type { GitWorktree } from '../types/vcs';
import { sessionWorkingDirectory } from './sessionWorkingDirectory';

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
