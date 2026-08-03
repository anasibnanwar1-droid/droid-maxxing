import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalUserTranscriptEvent,
  resolveSessionPromptMode,
  shouldQueueSessionPrompt,
} from './promptQueue';

test('main chat and Studio resolve the same live Enter behavior', () => {
  assert.equal(resolveSessionPromptMode({ isLive: true, liveEnterBehavior: 'interrupt' }), 'now');
  assert.equal(
    resolveSessionPromptMode({
      isLive: true,
      liveEnterBehavior: 'interrupt',
      alternate: true,
    }),
    'queue',
  );
  assert.equal(resolveSessionPromptMode({ isLive: true, liveEnterBehavior: 'queue' }), 'queue');
  assert.equal(
    resolveSessionPromptMode({
      isLive: true,
      liveEnterBehavior: 'queue',
      alternate: true,
    }),
    'now',
  );
  assert.equal(
    resolveSessionPromptMode({ isLive: false, liveEnterBehavior: 'interrupt', alternate: true }),
    'queue',
  );
});

test('only a live primary target stages queue-mode prompts', () => {
  assert.equal(shouldQueueSessionPrompt({ isLive: true, mode: 'queue' }), true);
  assert.equal(shouldQueueSessionPrompt({ isLive: true, mode: 'now' }), false);
  assert.equal(shouldQueueSessionPrompt({ isLive: false, mode: 'queue' }), false);
  assert.equal(
    shouldQueueSessionPrompt({ isLive: true, mode: 'queue', isPrimaryTarget: false }),
    false,
  );
});

test('the shared optimistic event keeps attachments and safe-boundary steer metadata together', () => {
  assert.deepEqual(
    createLocalUserTranscriptEvent({
      appSessionId: 'app-1',
      text: 'Use this reference',
      skills: ['frontend-design'],
      files: ['/repo/reference.png'],
      browserRefs: [{ id: 'moodboard-1', label: 'Moodboard', kind: 'region' }],
      steered: true,
      now: 42,
    }),
    {
      id: 'local-42',
      appSessionId: 'app-1',
      sourceSessionId: 'user',
      role: 'primary',
      ts: 42,
      kind: 'text',
      text: 'Use this reference',
      author: 'user',
      skills: ['frontend-design'],
      files: ['/repo/reference.png'],
      browserRefs: [{ id: 'moodboard-1', label: 'Moodboard', kind: 'region' }],
      steered: true,
    },
  );
});
