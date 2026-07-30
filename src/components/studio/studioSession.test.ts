import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createQueuedStudioPrompt,
  pendingStudioClientRef,
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
