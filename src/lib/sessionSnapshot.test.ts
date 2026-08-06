import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionSummary, TranscriptEvent } from '../types/bridge';
import { withLocalStorageMap } from '../test/localStorage';
import {
  loadSessionSnapshot,
  saveSessionSnapshot,
  MAX_SNAPSHOT_SESSIONS,
  MAX_SNAPSHOT_TRANSCRIPT_EVENTS,
  MAX_SNAPSHOT_TRANSCRIPT_BYTES,
} from './sessionSnapshot';

const SNAPSHOT_KEY = 'droid-session-snapshot-v1';

function summary(id: string, updatedAt = 1): SessionSummary {
  return {
    appSessionId: id,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: `Chat ${id}`,
    goal: `Chat ${id}`,
    cwd: '/repo',
    autonomy: 'low',
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}

function event(id: string, ts: number, text = id): TranscriptEvent {
  return {
    id,
    appSessionId: 's1',
    sourceSessionId: 'primary',
    role: 'primary',
    kind: 'text',
    text,
    ts,
  };
}

function saveAndLoad(
  sessions: SessionSummary[],
  transcript?: { appSessionId: string; events: TranscriptEvent[] },
): ReturnType<typeof loadSessionSnapshot> {
  let snapshot: ReturnType<typeof loadSessionSnapshot>;
  withLocalStorageMap({}, () => {
    saveSessionSnapshot(
      Object.fromEntries(sessions.map((item) => [item.appSessionId, item])),
      sessions.map((item) => item.appSessionId),
      transcript,
    );
    snapshot = loadSessionSnapshot();
  });
  return snapshot!;
}

test('a saved snapshot round-trips sessions in order with the transcript', () => {
  const snapshot = saveAndLoad([summary('s1', 2), summary('s2', 1)], {
    appSessionId: 's1',
    events: [event('a', 1), event('b', 2)],
  });
  assert.deepEqual(snapshot?.sessionOrder, ['s1', 's2']);
  assert.equal(snapshot?.sessions.s1?.title, 'Chat s1');
  assert.equal(snapshot?.sessions.s2?.title, 'Chat s2');
  assert.equal(snapshot?.transcript?.appSessionId, 's1');
  assert.equal(snapshot?.transcript?.events.length, 2);
});

test('missing or corrupt payloads degrade to no snapshot', () => {
  withLocalStorageMap({}, () => {
    assert.equal(loadSessionSnapshot(), undefined);
  });
  for (const raw of ['{not json', '[]', '"text"', '{"sessions":{}}', '{"sessions":["bad"]}']) {
    withLocalStorageMap({ [SNAPSHOT_KEY]: raw }, () => {
      assert.equal(loadSessionSnapshot(), undefined, raw);
    });
  }
});

test('entries missing identity fields are dropped, valid ones survive', () => {
  withLocalStorageMap(
    {
      [SNAPSHOT_KEY]: JSON.stringify({
        sessions: [
          summary('good'),
          { ...summary('no-id'), appSessionId: 7 },
          { ...summary('no-title'), title: undefined },
          { ...summary('no-time'), updatedAt: 'yesterday' },
        ],
      }),
    },
    () => {
      const snapshot = loadSessionSnapshot();
      assert.deepEqual(snapshot?.sessionOrder, ['good']);
    },
  );
});

test('the session list is bounded to the most recent entries', () => {
  const many = Array.from({ length: MAX_SNAPSHOT_SESSIONS + 50 }, (_, i) => summary(`s${i}`, i));
  const snapshot = saveAndLoad(many);
  assert.equal(snapshot?.sessionOrder.length, MAX_SNAPSHOT_SESSIONS);
  assert.equal(snapshot?.sessionOrder[0], 's0');
});

test('the transcript is capped to the newest events and the byte budget', () => {
  const many = Array.from({ length: MAX_SNAPSHOT_TRANSCRIPT_EVENTS + 20 }, (_, i) =>
    event(`e${i}`, i),
  );
  const counted = saveAndLoad([summary('s1')], { appSessionId: 's1', events: many });
  assert.equal(counted?.transcript?.events.length, MAX_SNAPSHOT_TRANSCRIPT_EVENTS);
  assert.equal(counted?.transcript?.events[0]?.id, 'e20');

  const bulky = Array.from({ length: MAX_SNAPSHOT_TRANSCRIPT_EVENTS }, (_, i) =>
    event(`big-${i}`, i, 'x'.repeat(64 * 1024)),
  );
  const bounded = saveAndLoad([summary('s1')], { appSessionId: 's1', events: bulky });
  const kept = bounded?.transcript?.events ?? [];
  assert.ok(kept.length < bulky.length, 'oldest events dropped to fit the byte budget');
  assert.ok(
    JSON.stringify(kept).length <= MAX_SNAPSHOT_TRANSCRIPT_BYTES * 2,
    'serialized size roughly within budget',
  );
});

test('a transcript for an unknown session is not hydrated', () => {
  withLocalStorageMap(
    {
      [SNAPSHOT_KEY]: JSON.stringify({
        sessions: [summary('s1')],
        transcript: { appSessionId: 'ghost', events: [event('a', 1)] },
      }),
    },
    () => {
      const snapshot = loadSessionSnapshot();
      assert.deepEqual(snapshot?.sessionOrder, ['s1']);
      assert.equal(snapshot?.transcript, undefined);
    },
  );
});

test('storage failures are swallowed on both read and write', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    },
  });
  try {
    assert.equal(loadSessionSnapshot(), undefined);
    saveSessionSnapshot({ s1: summary('s1') }, ['s1']);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
