import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/Sidebar.tsx', import.meta.url), 'utf8');

test('launch checks can discover updates but never start installation', () => {
  assert.match(appSource, /refreshAppUpdate\(\{ interactive: false, automaticChecks: true \}\)/);
  assert.doesNotMatch(appSource, /startAppUpdate/);
});

test('sidebar download button only appears for a discovered update', () => {
  assert.match(sidebarSource, /if \(!update\?\.updateAvailable\) return null/);
  assert.match(sidebarSource, /Review DROIDEX \$\{update\.latest\} update/);
  assert.match(sidebarSource, /void start\(\)/);
  assert.doesNotMatch(sidebarSource, /void check\(\)/);
});
