import test from 'node:test';
import assert from 'node:assert/strict';
import { availableChannels, compareSemver } from './Environment.js';

test('compareSemver orders versions numerically', () => {
  assert.ok(compareSemver('0.144.2', '0.144.1') > 0);
  assert.ok(compareSemver('0.99.0', '0.100.0') < 0);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
});

test('compareSemver tolerates prefixes and missing values', () => {
  assert.equal(compareSemver('v1.0.0', '1.0.0'), 0);
  assert.ok(compareSemver(undefined, '0.0.1') < 0);
  assert.equal(compareSemver(undefined, undefined), 0);
});

test('availableChannels reflects detected package managers in priority order', () => {
  assert.deepEqual(
    availableChannels({ brew: true, npm: true, curl: true, pnpm: false }),
    ['script', 'brew', 'npm'],
  );
  assert.deepEqual(
    availableChannels({ brew: false, npm: true, curl: false, pnpm: false }),
    ['npm'],
  );
  assert.deepEqual(
    availableChannels({ brew: false, npm: false, curl: false, pnpm: false }),
    [],
  );
});
