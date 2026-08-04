import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/Sidebar.tsx', import.meta.url), 'utf8');
const updateSource = readFileSync(new URL('./appUpdate.ts', import.meta.url), 'utf8');

test('launch checks can discover updates but never start installation', () => {
  assert.match(appSource, /refreshAppUpdate\(\{ interactive: false, automaticChecks: true \}\)/);
  assert.doesNotMatch(appSource, /startAppUpdate/);
});

test('sidebar always exposes a user-initiated update check', () => {
  assert.doesNotMatch(sidebarSource, /if \(!update\?\.updateAvailable\) return null/);
  assert.match(sidebarSource, /canInstall \? start\(\) : check\(\)/);
  assert.match(sidebarSource, /Check for DROIDEX updates/);
  assert.match(updateSource, /interactive: true/);
  assert.match(updateSource, /configureAutomaticChecks: false/);
});
