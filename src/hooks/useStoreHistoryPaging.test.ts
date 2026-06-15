import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
import type { AppState } from './useStore';
import type { TranscriptEvent } from '../types/bridge';

function ev(id: string, ts: number, text = id): TranscriptEvent {
  return {
    id,
    missionId: 'm1',
    agentSessionId: 'orchestrator',
    role: 'orchestrator',
    kind: 'text',
    text,
    ts,
  };
}

test('MISSION_HISTORY replace seeds the transcript and the older cursor', () => {
  const next = reducer(initialState as unknown as AppState, {
    type: 'MISSION_HISTORY',
    missionId: 'm1',
    progress: [],
    transcripts: [ev('c', 3), ev('d', 4)],
    mode: 'replace',
    olderCursor: '1:end',
  });

  assert.deepEqual(
    next.transcripts.m1.map((e) => e.id),
    ['c', 'd'],
  );
  assert.equal(next.historyCursor.m1, '1:end');
  assert.equal(next.historyLoadingOlder.m1, false);
  assert.equal(next.historyLoaded.m1, true);
});

test('MISSION_HISTORY prepend prepends older events ahead of the existing scrollback', () => {
  const seeded = {
    ...initialState,
    transcripts: { m1: [ev('c', 3), ev('d', 4)] },
    historyCursor: { m1: '1:end' },
    historyLoadingOlder: { m1: true },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'MISSION_HISTORY',
    missionId: 'm1',
    progress: [],
    transcripts: [ev('a', 1), ev('b', 2)],
    mode: 'prepend',
    olderCursor: '0:end',
  });

  assert.deepEqual(
    next.transcripts.m1.map((e) => e.id),
    ['a', 'b', 'c', 'd'],
  );
  assert.equal(next.historyCursor.m1, '0:end');
  assert.equal(next.historyLoadingOlder.m1, false);
});

test('MISSION_HISTORY prepend dedups events already present at the boundary', () => {
  const seeded = {
    ...initialState,
    transcripts: { m1: [ev('b', 2), ev('c', 3)] },
    historyLoadingOlder: { m1: true },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'MISSION_HISTORY',
    missionId: 'm1',
    progress: [],
    transcripts: [ev('a', 1), ev('b', 2)],
    mode: 'prepend',
    olderCursor: undefined,
  });

  // 'b' overlaps the existing head and must not be duplicated.
  assert.deepEqual(
    next.transcripts.m1.map((e) => e.id),
    ['a', 'b', 'c'],
  );
  assert.equal(next.historyCursor.m1, undefined);
  assert.equal(next.historyLoadingOlder.m1, false);
});

test('MISSION_HISTORY prepend with a fully-duplicate page only clears the loading flag', () => {
  const existing = [ev('a', 1), ev('b', 2)];
  const seeded = {
    ...initialState,
    transcripts: { m1: existing },
    historyLoadingOlder: { m1: true },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'MISSION_HISTORY',
    missionId: 'm1',
    progress: [],
    transcripts: [ev('a', 1)],
    mode: 'prepend',
    olderCursor: undefined,
  });

  assert.equal(next.transcripts.m1, existing);
  assert.equal(next.historyLoadingOlder.m1, false);
});

test('MISSION_HISTORY_LOADING_OLDER marks the in-flight prefetch', () => {
  const next = reducer(initialState as unknown as AppState, {
    type: 'MISSION_HISTORY_LOADING_OLDER',
    missionId: 'm1',
  });
  assert.equal(next.historyLoadingOlder.m1, true);
});
