import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createQueuedStudioPrompt,
  latestStudioSessionId,
  pendingStudioClientRef,
  recoverStudioSessionId,
  studioSessionTitle,
} from './studioSession';

test('studio titles come from clean visible user intent', () => {
  assert.equal(
    studioSessionTitle('  Build   a calmer settings page  '),
    'Build a calmer settings page',
  );
  assert.equal(studioSessionTitle('Apply the attached canvas references.'), 'Canvas references');
  assert.equal(studioSessionTitle('x'.repeat(80)), `${'x'.repeat(47)}…`);
});

test('pending Studio compose is scoped to its project', () => {
  const expected = { 'client-a': '/repo/a', 'client-b': '/repo/b' };
  const pending = { 'client-b': { text: 'B' } };
  assert.equal(pendingStudioClientRef(expected, pending, ['/repo/a']), undefined);
  assert.equal(pendingStudioClientRef(expected, pending, ['/repo/b']), 'client-b');
});

test('Studio recovers the latest design thread for a project after renderer reload', () => {
  assert.equal(
    latestStudioSessionId(
      [
        {
          appSessionId: 'ordinary-newer',
          cwd: '/repo/worktree',
          updatedAt: 30,
          sessionPurpose: 'ordinary',
        },
        {
          appSessionId: 'design-older',
          cwd: '/repo/live',
          updatedAt: 10,
          sessionPurpose: 'design',
        },
        {
          appSessionId: 'design-latest',
          cwd: '/repo/worktree',
          updatedAt: 20,
          sessionPurpose: 'design',
        },
        {
          appSessionId: 'other-project',
          cwd: '/other',
          updatedAt: 40,
          sessionPurpose: 'design',
        },
      ],
      ['/repo/live', '/repo/worktree'],
    ),
    'design-latest',
  );
});

test('Studio never adopts ordinary or live-checkout sessions', () => {
  const sessions = [
    {
      appSessionId: 'ordinary-active',
      cwd: '/repo/worktree',
      updatedAt: 40,
      sessionPurpose: 'chat' as const,
    },
    {
      appSessionId: 'design-live',
      cwd: '/repo/live',
      updatedAt: 30,
      sessionPurpose: 'design' as const,
    },
    {
      appSessionId: 'design-isolated',
      cwd: '/repo/worktree',
      updatedAt: 20,
      sessionPurpose: 'design' as const,
    },
  ];

  assert.equal(
    recoverStudioSessionId(sessions, 'ordinary-active', '/repo/worktree'),
    'design-isolated',
  );
  assert.equal(
    recoverStudioSessionId(sessions, 'design-live', '/repo/worktree'),
    'design-isolated',
  );
});

test('Studio queue preserves provider context separately from visible text', () => {
  const browserRefs = [{ id: 'image-1', label: 'Moodboard', kind: 'region' as const }];
  assert.deepEqual(
    createQueuedStudioPrompt({
      id: 'queue-1',
      displayText: 'Use this visual direction',
      prompt: 'Use this visual direction\n\nDROIDEX DESIGN reference pack: {...}',
      browserRefs,
    }),
    {
      id: 'queue-1',
      text: 'Use this visual direction',
      skills: [],
      files: [],
      studio: {
        prompt: 'Use this visual direction\n\nDROIDEX DESIGN reference pack: {...}',
        browserRefs,
      },
    },
  );
});
