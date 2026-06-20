import test from 'node:test';
import assert from 'node:assert';
import { bucketToStatus, checksSummary, prKind, prKindLabel } from './github';
import type { PrCheck } from '../types/vcs';

const check = (bucket: string): PrCheck => ({
  name: 'ci',
  workflow: null,
  bucket,
  state: '',
  description: '',
  link: null,
  startedAt: null,
  completedAt: null,
});

test('prKind maps state and draft flag', () => {
  assert.equal(prKind({ state: 'MERGED', isDraft: false }), 'merged');
  assert.equal(prKind({ state: 'CLOSED', isDraft: false }), 'closed');
  assert.equal(prKind({ state: 'OPEN', isDraft: true }), 'draft');
  assert.equal(prKind({ state: 'open', isDraft: false }), 'open');
});

test('prKindLabel renders human labels', () => {
  assert.equal(prKindLabel('merged'), 'Merged');
  assert.equal(prKindLabel('draft'), 'Draft');
  assert.equal(prKindLabel('open'), 'Open');
  assert.equal(prKindLabel('closed'), 'Closed');
});

test('bucketToStatus normalizes gh buckets and check states', () => {
  assert.equal(bucketToStatus('pass'), 'success');
  assert.equal(bucketToStatus('SUCCESS'), 'success');
  assert.equal(bucketToStatus('fail'), 'failure');
  assert.equal(bucketToStatus('cancel'), 'failure');
  assert.equal(bucketToStatus('pending'), 'pending');
  assert.equal(bucketToStatus('skipping'), 'neutral');
});

test('checksSummary is failure when any check fails, pending otherwise', () => {
  assert.deepEqual(checksSummary([]), { total: 0, pass: 0, fail: 0, pending: 0, status: 'none' });
  assert.deepEqual(checksSummary([check('pass'), check('pass')]), {
    total: 2,
    pass: 2,
    fail: 0,
    pending: 0,
    status: 'success',
  });
  assert.equal(checksSummary([check('pass'), check('pending')]).status, 'pending');
  assert.equal(checksSummary([check('pass'), check('fail'), check('pending')]).status, 'failure');
});
