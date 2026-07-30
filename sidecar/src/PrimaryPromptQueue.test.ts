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

test('an elected preflight prompt remains ahead of later steers', () => {
  const queue = new PrimaryPromptQueue();
  queue.protectHead({ text: 'causal prompt', priority: 'queue' });
  queue.enqueue('steer one', 'steer');
  queue.enqueue('steer two', 'steer');

  assert.deepEqual(queue.drain(), [
    { text: 'causal prompt', priority: 'queue' },
    { text: 'steer one', priority: 'steer' },
    { text: 'steer two', priority: 'steer' },
  ]);
});

test('clear removes protected and ordinary work', () => {
  const queue = new PrimaryPromptQueue();
  queue.protectHead({ text: 'protected', priority: 'steer' });
  queue.enqueue('ordinary', 'queue');

  queue.clear();

  assert.equal(queue.size, 0);
  assert.deepEqual(queue.snapshot(), []);
});
