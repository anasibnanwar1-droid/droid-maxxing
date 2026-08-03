import assert from 'node:assert/strict';
import test from 'node:test';
import { PrimaryPromptQueue } from './PrimaryPromptQueue.js';

test('steers stay FIFO ahead of ordinary queued prompts', () => {
  const queue = new PrimaryPromptQueue();
  queue.enqueue('ordinary one', 'queue');
  queue.enqueue('steer one', 'steer');
  queue.enqueue('steer two', 'steer');
  queue.enqueue('ordinary two', 'queue');

  assert.deepEqual(queue.drain(), [
    { text: 'steer one', priority: 'steer' },
    { text: 'steer two', priority: 'steer' },
    { text: 'ordinary one', priority: 'queue' },
    { text: 'ordinary two', priority: 'queue' },
  ]);
});

test('clear removes all work', () => {
  const queue = new PrimaryPromptQueue();
  queue.enqueue('steer', 'steer');
  queue.enqueue('ordinary', 'queue');

  queue.clear();

  assert.equal(queue.size, 0);
  assert.deepEqual(queue.snapshot(), []);
});
