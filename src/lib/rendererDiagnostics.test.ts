import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDiagnosticsBreadcrumb,
  setDiagnosticsContext,
  getSessionLog,
  getCurrentAppState,
  __resetDiagnosticsForTest,
} from './rendererDiagnostics';

test('addDiagnosticsBreadcrumb ignores disallowed categories', () => {
  __resetDiagnosticsForTest();
  addDiagnosticsBreadcrumb('console', 'leaked log');
  addDiagnosticsBreadcrumb('fetch', 'GET /api/secret');
  addDiagnosticsBreadcrumb('ui.click', 'button pressed');
  assert.equal(getSessionLog().length, 0);
});

test('addDiagnosticsBreadcrumb records allowed categories into the session log', () => {
  __resetDiagnosticsForTest();
  addDiagnosticsBreadcrumb('session', 'mode changed to spec');
  addDiagnosticsBreadcrumb('app', 'app focused');
  addDiagnosticsBreadcrumb('bridge', 'bridge connected');
  addDiagnosticsBreadcrumb('navigation', 'navigated to /settings');

  const log = getSessionLog();
  assert.equal(log.length, 4);
  assert.equal(log[0].category, 'session');
  assert.equal(log[0].message, 'mode changed to spec');
  assert.equal(log[1].category, 'app');
  assert.equal(log[2].category, 'bridge');
  assert.equal(log[3].category, 'navigation');
  for (const entry of log) {
    assert.equal(typeof entry.timestamp, 'number');
  }
});

test('session log ring buffer caps at 50 entries with FIFO eviction', () => {
  __resetDiagnosticsForTest();
  for (let i = 0; i < 60; i++) {
    addDiagnosticsBreadcrumb('session', `entry ${i}`);
  }
  const log = getSessionLog();
  assert.equal(log.length, 50);
  assert.equal(log[0].message, 'entry 10');
  assert.equal(log[49].message, 'entry 59');
});

test('getSessionLog returns a copy — mutations do not affect internal state', () => {
  __resetDiagnosticsForTest();
  addDiagnosticsBreadcrumb('session', 'original');
  const log = getSessionLog();
  log.push({ category: 'session', message: 'injected', level: 'info', timestamp: 0 });
  log[0].message = 'tampered';

  const fresh = getSessionLog();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].message, 'original');
});

test('setDiagnosticsContext stores a copy — later mutation does not affect stored state', () => {
  __resetDiagnosticsForTest();
  const state = { interactionMode: 'spec', view: 'chat' };
  setDiagnosticsContext(state);
  state.interactionMode = 'auto';

  const stored = getCurrentAppState();
  assert.equal(stored.interactionMode, 'spec');
});

test('getCurrentAppState returns a copy — mutations do not affect internal state', () => {
  __resetDiagnosticsForTest();
  setDiagnosticsContext({ interactionMode: 'auto', view: 'chat' });
  const snapshot = getCurrentAppState();
  snapshot.interactionMode = 'spec';

  const fresh = getCurrentAppState();
  assert.equal(fresh.interactionMode, 'auto');
});
