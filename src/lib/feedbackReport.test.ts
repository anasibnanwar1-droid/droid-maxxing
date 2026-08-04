import assert from 'node:assert/strict';
import test from 'node:test';
import { feedbackDraftFromCommand } from './feedbackReport';

test('feedbackDraftFromCommand opens bug and feedback reports with optional details', () => {
  assert.deepEqual(feedbackDraftFromCommand('/bug'), { category: 'bug', description: '' });
  assert.deepEqual(feedbackDraftFromCommand('/bug    update froze   '), {
    category: 'bug',
    description: 'update froze',
  });
  assert.deepEqual(feedbackDraftFromCommand('/feedback'), {
    category: 'other',
    description: '',
  });
  assert.deepEqual(feedbackDraftFromCommand('/feedback great result'), {
    category: 'other',
    description: 'great result',
  });
  assert.equal(feedbackDraftFromCommand('/buggy nope'), null);
  assert.equal(feedbackDraftFromCommand('/feedbacks nope'), null);
});
