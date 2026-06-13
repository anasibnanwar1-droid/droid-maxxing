import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
import type { AppState } from './useStore';

function missionList(missions: Array<{ id: string; sessionId: string }>) {
  return {
    type: 'MISSION_LIST' as const,
    missions: missions.map((m, i) => ({ id: m.id, sessionId: m.sessionId, title: m.id, phase: 'running', updatedAt: i + 1 })),
  };
}

test('MISSION_LIST migrates persisted browser panes from old session id to stable mission id', () => {
  const start = {
    ...initialState,
    browsers: { 'sess-1': { missionId: 'sess-1', sessionId: 'sess-1', url: 'https://a.test' } },
    browserOpenKeys: { 'sess-1': true },
  } as unknown as AppState;

  const next = reducer(start, missionList([{ id: 'm1', sessionId: 'sess-1' }]) as never);

  // The pane moves to the stable mission id and its missionId field follows.
  assert.equal(next.browsers['sess-1'], undefined);
  assert.equal(next.browsers.m1?.url, 'https://a.test');
  assert.equal(next.browsers.m1?.missionId, 'm1');
  assert.equal(next.browserOpenKeys['sess-1'], undefined);
  assert.equal(next.browserOpenKeys.m1, true);
});

test('MISSION_LIST browser migration is a no-op when the old session key is absent', () => {
  const start = {
    ...initialState,
    browsers: { m1: { missionId: 'm1', sessionId: 'sess-1', url: 'https://a.test' } },
    browserOpenKeys: { m1: true },
  } as unknown as AppState;

  const next = reducer(start, missionList([{ id: 'm1', sessionId: 'sess-1' }]) as never);

  assert.equal(next.browsers.m1?.url, 'https://a.test');
  assert.equal(next.browserOpenKeys.m1, true);
  // Identity preserved (no needless copy) when nothing migrates.
  assert.equal(next.browsers, start.browsers);
  assert.equal(next.browserOpenKeys, start.browserOpenKeys);
});

test('MISSION_LIST browser migration never overwrites an existing stable-id pane', () => {
  // A fresh post-upgrade pane already lives under mission.id; a leftover
  // old-session-id entry must not clobber it.
  const start = {
    ...initialState,
    browsers: {
      'sess-1': { missionId: 'sess-1', sessionId: 'sess-1', url: 'https://stale.test' },
      m1: { missionId: 'm1', sessionId: 'sess-1', url: 'https://fresh.test' },
    },
    browserOpenKeys: { 'sess-1': false, m1: true },
  } as unknown as AppState;

  const next = reducer(start, missionList([{ id: 'm1', sessionId: 'sess-1' }]) as never);

  // The fresh stable-id pane wins.
  assert.equal(next.browsers.m1?.url, 'https://fresh.test');
  assert.equal(next.browserOpenKeys.m1, true);
});

test('MISSION_LIST browser migration is a no-op when sessionId equals mission id', () => {
  const start = {
    ...initialState,
    browsers: { m1: { missionId: 'm1', sessionId: 'm1', url: 'https://a.test' } },
    browserOpenKeys: { m1: true },
  } as unknown as AppState;

  const next = reducer(start, missionList([{ id: 'm1', sessionId: 'm1' }]) as never);

  assert.equal(next.browsers, start.browsers);
  assert.equal(next.browserOpenKeys, start.browserOpenKeys);
});
