import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRelativeTime } from './time';

const NOW = 1_700_000_000_000;

test('formatRelativeTime renders compact buckets', () => {
  assert.equal(formatRelativeTime(NOW, NOW), 'now');
  assert.equal(formatRelativeTime(NOW - 30_000, NOW), 'now');
  assert.equal(formatRelativeTime(NOW - 23 * 60_000, NOW), '23m');
  assert.equal(formatRelativeTime(NOW - 60 * 60_000, NOW), '1h');
  assert.equal(formatRelativeTime(NOW - 2 * 3_600_000, NOW), '2h');
  assert.equal(formatRelativeTime(NOW - 3 * 86_400_000, NOW), '3d');
  assert.equal(formatRelativeTime(NOW - 14 * 86_400_000, NOW), '2w');
  assert.equal(formatRelativeTime(NOW - 60 * 86_400_000, NOW), '2mo');
});

test('formatRelativeTime never renders a zero-year label near the year boundary', () => {
  const day = 86_400_000;
  assert.equal(formatRelativeTime(NOW - 359 * day, NOW), '11mo');
  assert.equal(formatRelativeTime(NOW - 360 * day, NOW), '1y');
  assert.equal(formatRelativeTime(NOW - 364 * day, NOW), '1y');
  assert.equal(formatRelativeTime(NOW - 365 * day, NOW), '1y');
  assert.equal(formatRelativeTime(NOW - 800 * day, NOW), '2y');
});

test('formatRelativeTime handles missing and future timestamps', () => {
  assert.equal(formatRelativeTime(0, NOW), '');
  assert.equal(formatRelativeTime(NOW + 60_000, NOW), 'now');
});
