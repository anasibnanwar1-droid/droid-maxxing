import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingStudioClientRef, studioSessionTitle } from './studioSession';

test('studio titles come from clean visible user intent', () => {
  assert.equal(
    studioSessionTitle('  Build   a calmer settings page  '),
    'Build a calmer settings page',
  );
  assert.equal(studioSessionTitle('Apply the attached canvas notes.'), 'Canvas notes');
  assert.equal(studioSessionTitle('x'.repeat(80)), `${'x'.repeat(47)}…`);
});

test('pending Studio compose is scoped to its project', () => {
  const expected = { 'client-a': '/repo/a', 'client-b': '/repo/b' };
  const pending = { 'client-b': { text: 'B' } };
  assert.equal(pendingStudioClientRef(expected, pending, ['/repo/a']), undefined);
  assert.equal(pendingStudioClientRef(expected, pending, ['/repo/b']), 'client-b');
});
