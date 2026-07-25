import assert from 'node:assert/strict';
import test from 'node:test';
import { stableDesignHash } from './iframeDesignMode';

test('stableDesignHash distinguishes selectors that collide under a 32-bit polynomial hash', () => {
  assert.notEqual(stableDesignHash('Aa'), stableDesignHash('BB'));
  assert.equal(stableDesignHash('#submit'), stableDesignHash('#submit'));
});
