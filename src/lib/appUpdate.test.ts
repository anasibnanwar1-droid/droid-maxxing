import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

test('launch checks can discover updates but never start installation', () => {
  assert.match(appSource, /refreshAppUpdate\(\{ interactive: false, automaticChecks: true \}\)/);
  assert.doesNotMatch(appSource, /startAppUpdate/);
});
