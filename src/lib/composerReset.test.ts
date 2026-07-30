import assert from 'node:assert/strict';
import test from 'node:test';
import { resetComposerAfterSubmit } from './composerReset';

test('resetComposerAfterSubmit clears images and the draft when untouched', () => {
  const calls: string[] = [];
  resetComposerAfterSubmit({
    draftUntouched: true,
    clearImages: () => calls.push('images'),
    resetDraft: () => calls.push('draft'),
  });
  assert.deepEqual(calls, ['images', 'draft']);
});

test('resetComposerAfterSubmit keeps draft edits made while images encoded', () => {
  // Regression: the submit path snapshots the composer before awaiting
  // in-flight image encodes; typing or staging during that wait must survive
  // the submit, or the user's in-progress next prompt is silently wiped.
  // Images still clear — they already made it into the sent prompt.
  const calls: string[] = [];
  resetComposerAfterSubmit({
    draftUntouched: false,
    clearImages: () => calls.push('images'),
    resetDraft: () => calls.push('draft'),
  });
  assert.deepEqual(calls, ['images']);
});
