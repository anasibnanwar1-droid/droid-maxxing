import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState, type AppState } from './useStore';
import type { SessionSummary } from '../types/bridge';

function session(providerSessionId: string): SessionSummary {
  return {
    appSessionId: 'app-1',
    providerSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: 'Browser identity',
    goal: '',
    cwd: '',
    autonomy: 'off',
    phase: 'running',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

test('SESSION_LIST keeps browser state keyed by stable app session identity', () => {
  const browser = {
    appSessionId: 'app-1',
    browserSessionId: 'browser-1',
    url: 'https://example.test',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    viewportMode: 'fit' as const,
    scroll: { x: 0, y: 0 },
    refs: [],
  };
  const start: AppState = {
    ...initialState,
    browsers: { 'app-1': browser },
    browserOpenKeys: { 'app-1': true },
  };

  const next = reducer(start, { type: 'SESSION_LIST', sessions: [session('provider-2')] });

  assert.equal(next.browsers, start.browsers);
  assert.equal(next.browserOpenKeys, start.browserOpenKeys);
  assert.equal(next.browsers['app-1'].browserSessionId, 'browser-1');
  assert.equal(next.sessions['app-1'].providerSessionId, 'provider-2');
});
