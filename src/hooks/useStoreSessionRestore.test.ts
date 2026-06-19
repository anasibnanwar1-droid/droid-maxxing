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

function userEv(id: string, ts: number, text: string): TranscriptEvent {
  return {
    id,
    missionId: 'm1',
    agentSessionId: 'user',
    role: 'orchestrator',
    kind: 'text',
    text,
    ts,
    author: 'user',
  };
}

test('#29 SESSION_RESTORE_START marks the transcript as loading', () => {
  const next = reducer(initialState as unknown as AppState, {
    type: 'SESSION_RESTORE_START',
    missionId: 'm1',
  });
  assert.deepEqual(next.sessionRestore.m1, { status: 'loading', loadedCount: 0, hasMore: false });
});

test('#29 a fully-loaded replace reports loaded with the event count and no more pages', () => {
  const next = reducer(initialState as unknown as AppState, {
    type: 'MISSION_HISTORY',
    missionId: 'm1',
    progress: [],
    transcripts: [ev('a', 1), ev('b', 2)],
    mode: 'replace',
    olderCursor: undefined,
    loadedCount: 2,
    hasMore: false,
  });
  assert.deepEqual(next.sessionRestore.m1, { status: 'loaded', loadedCount: 2, hasMore: false });
});

test('#29 a replace that leaves an older cursor reports a partial (paged) restore', () => {
  const next = reducer(initialState as unknown as AppState, {
    type: 'MISSION_HISTORY',
    missionId: 'm1',
    progress: [],
    transcripts: [ev('c', 3), ev('d', 4)],
    mode: 'replace',
    olderCursor: '1:end',
    hasMore: true,
  });
  assert.equal(next.sessionRestore.m1.status, 'paged');
  assert.equal(next.sessionRestore.m1.hasMore, true);
  assert.equal(next.sessionRestore.m1.loadedCount, 2);
});

test('#29 a replace never clobbers live events that streamed in before the snapshot', () => {
  // A reconnect to a running mission can deliver a live transcript event before
  // the history snapshot; that event must survive the replace.
  const seeded = {
    ...initialState,
    transcripts: { m1: [ev('live-1', 99)] },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'MISSION_HISTORY',
    missionId: 'm1',
    progress: [],
    transcripts: [ev('a', 1), ev('b', 2)],
    mode: 'replace',
    olderCursor: undefined,
    hasMore: false,
  });

  assert.deepEqual(
    next.transcripts.m1.map((e) => e.id),
    ['a', 'b', 'live-1'],
  );
  assert.equal(next.sessionRestore.m1.loadedCount, 3);
});

test('#29 a replace prefers the authoritative page for events shared with live state', () => {
  const seeded = {
    ...initialState,
    transcripts: { m1: [ev('a', 1, 'partial')] },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'MISSION_HISTORY',
    missionId: 'm1',
    progress: [],
    transcripts: [ev('a', 1, 'complete')],
    mode: 'replace',
    hasMore: false,
  });

  assert.deepEqual(
    next.transcripts.m1.map((e) => e.id),
    ['a'],
  );
  assert.equal(next.transcripts.m1[0].text, 'complete');
});

test('#29 a replace drops the optimistic opening prompt the restored page already contains', () => {
  // The seeded echo and the persisted user message share text but not id; the
  // page is authoritative, so the echo must not double-render.
  const seeded = {
    ...initialState,
    transcripts: { m1: [userEv('seed-m1', 1, 'hello there')] },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'MISSION_HISTORY',
    missionId: 'm1',
    progress: [],
    transcripts: [userEv('real-user', 1, 'hello there'), ev('asst', 2, 'hi')],
    mode: 'replace',
    hasMore: false,
  });

  assert.deepEqual(
    next.transcripts.m1.map((e) => e.id),
    ['real-user', 'asst'],
  );
});

test('#29 a replace keeps an un-persisted opening prompt above the restored page', () => {
  // History returned assistant events but not the user message yet; the seeded
  // prompt is older than the page and must stay at the top, not slide below it.
  const seeded = {
    ...initialState,
    transcripts: { m1: [userEv('seed-m1', 1, 'hello there')] },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'MISSION_HISTORY',
    missionId: 'm1',
    progress: [],
    transcripts: [ev('asst', 5, 'response only')],
    mode: 'replace',
    hasMore: false,
  });

  assert.deepEqual(
    next.transcripts.m1.map((e) => e.id),
    ['seed-m1', 'asst'],
  );
});

test('#29 MISSION_HISTORY_FAILED records a failed restore but keeps any prior count', () => {
  const seeded = {
    ...initialState,
    sessionRestore: { m1: { status: 'loading', loadedCount: 5, hasMore: true } },
  } as unknown as AppState;

  const next = reducer(seeded, {
    type: 'MISSION_HISTORY_FAILED',
    missionId: 'm1',
    message: 'session file unreadable',
  });

  assert.deepEqual(next.sessionRestore.m1, {
    status: 'failed',
    loadedCount: 5,
    hasMore: true,
    error: 'session file unreadable',
  });
});

test('#29 prepend grows the restore count and resolves to loaded when no cursor remains', () => {
  const seeded = {
    ...initialState,
    transcripts: { m1: [ev('c', 3), ev('d', 4)] },
    sessionRestore: { m1: { status: 'paged', loadedCount: 2, hasMore: true } },
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

  assert.equal(next.sessionRestore.m1.status, 'loaded');
  assert.equal(next.sessionRestore.m1.hasMore, false);
  assert.equal(next.sessionRestore.m1.loadedCount, 4);
});
