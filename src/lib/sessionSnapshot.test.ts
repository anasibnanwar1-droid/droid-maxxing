import test from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeFeature, SessionSummary, TranscriptEvent } from '../types/bridge';
import { withLocalStorageMap } from '../test/localStorage';
import {
  createSnapshotScheduler,
  loadSessionSnapshot,
  saveSessionSnapshot,
  MAX_SNAPSHOT_SESSIONS,
  MAX_SNAPSHOT_SUMMARY_BYTES,
  MAX_SNAPSHOT_TRANSCRIPT_EVENTS,
  MAX_SNAPSHOT_TRANSCRIPT_BYTES,
} from './sessionSnapshot';

const SNAPSHOT_KEY = 'droid-session-snapshot-v1';

function feature(id: string, overrides: Partial<BridgeFeature> = {}): BridgeFeature {
  return {
    id,
    description: `Feature ${id}`,
    status: 'pending',
    skillName: 'skill',
    preconditions: [],
    expectedBehavior: [],
    verificationSteps: [],
    ...overrides,
  };
}

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
    JSON.stringify(kept).length <= MAX_SNAPSHOT_TRANSCRIPT_BYTES,
    'serialized size within budget',
  );
});

test('duplicate session ids in a stored payload are collapsed', () => {
  withLocalStorageMap(
    { [SNAPSHOT_KEY]: JSON.stringify({ sessions: [summary('s1', 1), summary('s1', 2)] }) },
    () => {
      const snapshot = loadSessionSnapshot();
      assert.deepEqual(snapshot?.sessionOrder, ['s1']);
    },
  );
});

test('malformed transcript events are dropped on load', () => {
  withLocalStorageMap(
    {
      [SNAPSHOT_KEY]: JSON.stringify({
        sessions: [summary('s1')],
        transcript: {
          appSessionId: 's1',
          events: [
            event('ok', 1),
            { ...event('bad-id', 2), id: 9 },
            { ...event('bad-ts', 3), ts: 'now' },
          ],
        },
      }),
    },
    () => {
      const snapshot = loadSessionSnapshot();
      assert.deepEqual(
        snapshot?.transcript?.events.map((item) => item.id),
        ['ok'],
      );
    },
  );
});

test('the summary list is bounded to the byte budget, keeping the newest', () => {
  const bulky = Array.from({ length: 200 }, (_, i) => ({
    ...summary(`s${i}`, i),
    title: `Chat ${i} ${'t'.repeat(8 * 1024)}`,
  }));
  const snapshot = saveAndLoad(bulky);
  const kept = snapshot?.sessionOrder ?? [];
  assert.ok(kept.length >= 2, 'more than one summary fits the budget');
  assert.ok(kept.length < bulky.length, 'oldest summaries dropped to fit the byte budget');
  assert.equal(kept[0], 's0', 'the front of the order (newest) is kept');
  const serialized = JSON.stringify(kept.map((id) => snapshot?.sessions[id]));
  assert.ok(serialized.length <= MAX_SNAPSHOT_SUMMARY_BYTES);
});

test('the scheduler writes after the debounce delay', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withLocalStorageMap({}, () => {
    const scheduler = createSnapshotScheduler(400);
    scheduler.push({ sessions: { s1: summary('s1') }, sessionOrder: ['s1'] });
    t.mock.timers.tick(399);
    assert.equal(loadSessionSnapshot(), undefined);
    t.mock.timers.tick(1);
    assert.deepEqual(loadSessionSnapshot()?.sessionOrder, ['s1']);
  });
});

test('an unchanged push never cancels a pending write', (t) => {
  // Regression: the previous effect-owned timer was cleared by React cleanup
  // when an unrelated state change re-ran the effect, silently dropping the
  // scheduled snapshot.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withLocalStorageMap({}, () => {
    const scheduler = createSnapshotScheduler(400);
    const sessions = { s1: summary('s1') };
    const sessionOrder = ['s1'];
    scheduler.push({ sessions, sessionOrder });
    t.mock.timers.tick(200);
    scheduler.push({ sessions, sessionOrder });
    t.mock.timers.tick(200);
    assert.deepEqual(loadSessionSnapshot()?.sessionOrder, ['s1']);
  });
});

test('a changed push reschedules and the latest input wins', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withLocalStorageMap({}, () => {
    const scheduler = createSnapshotScheduler(400);
    scheduler.push({ sessions: { s1: summary('s1') }, sessionOrder: ['s1'] });
    t.mock.timers.tick(200);
    scheduler.push({
      sessions: { s1: summary('s1'), s2: summary('s2') },
      sessionOrder: ['s2', 's1'],
    });
    t.mock.timers.tick(399);
    assert.equal(loadSessionSnapshot(), undefined, 'rescheduled write has not fired yet');
    t.mock.timers.tick(1);
    assert.deepEqual(loadSessionSnapshot()?.sessionOrder, ['s2', 's1']);
  });
});

test('cancel discards a pending write', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  withLocalStorageMap({}, () => {
    const scheduler = createSnapshotScheduler(400);
    scheduler.push({ sessions: { s1: summary('s1') }, sessionOrder: ['s1'] });
    scheduler.cancel();
    t.mock.timers.tick(1000);
    assert.equal(loadSessionSnapshot(), undefined);
  });
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

// ── Finding 1: malformed BridgeFeature entries must not survive hydration ─

test('malformed feature entries are dropped on save+load, valid ones survive', () => {
  const withFeatures: SessionSummary = {
    ...summary('s1'),
    features: [
      feature('good'),
      { ...feature('no-id'), id: 9 } as unknown as BridgeFeature,
      { ...feature('no-desc'), description: undefined } as unknown as BridgeFeature,
      { ...feature('bad-status'), status: 'unknown' } as unknown as BridgeFeature,
      { ...feature('no-skill'), skillName: undefined } as unknown as BridgeFeature,
      {
        ...feature('bad-preconditions'),
        preconditions: 'not-an-array',
      } as unknown as BridgeFeature,
      {
        ...feature('bad-verification'),
        verificationSteps: [1, 2],
      } as unknown as BridgeFeature,
      'not-an-object' as unknown as BridgeFeature,
      null as unknown as BridgeFeature,
    ],
  };
  const snapshot = saveAndLoad([withFeatures]);
  const features = snapshot?.sessions.s1?.features ?? [];
  assert.deepEqual(
    features.map((f) => f.id),
    ['good'],
  );
});

test('optional feature fields are preserved or cleared on load', () => {
  const withFeatures: SessionSummary = {
    ...summary('s1'),
    features: [
      feature('f1', { fulfills: ['req-1'], milestone: 'M1' }),
      feature('f2', { fulfills: 'bad' as unknown as string[], milestone: 42 as unknown as string }),
    ],
  };
  const snapshot = saveAndLoad([withFeatures]);
  const features = snapshot?.sessions.s1?.features ?? [];
  assert.equal(features.length, 2);
  assert.deepEqual(features[0]?.fulfills, ['req-1']);
  assert.equal(features[0]?.milestone, 'M1');
  assert.equal(features[1]?.fulfills, undefined);
  assert.equal(features[1]?.milestone, undefined);
});

// ── Finding 2: transcript events must match transcript.appSessionId ────────

test('transcript events from a different session are dropped on load', () => {
  withLocalStorageMap(
    {
      [SNAPSHOT_KEY]: JSON.stringify({
        sessions: [summary('s1')],
        transcript: {
          appSessionId: 's1',
          events: [
            event('belongs', 1),
            { ...event('foreign'), appSessionId: 's2' },
            { ...event('also-foreign'), appSessionId: 's3' },
          ],
        },
      }),
    },
    () => {
      const snapshot = loadSessionSnapshot();
      assert.deepEqual(
        snapshot?.transcript?.events.map((e) => e.id),
        ['belongs'],
      );
    },
  );
});

// ── Finding 3: one oversized transcript event must not bypass the byte cap ─

test('a single oversized transcript event is dropped on save', () => {
  const huge = event('huge', 1, 'x'.repeat(MAX_SNAPSHOT_TRANSCRIPT_BYTES + 1));
  const snapshot = saveAndLoad([summary('s1')], { appSessionId: 's1', events: [huge] });
  assert.equal(snapshot?.transcript, undefined);
});

test('a single oversized transcript event is dropped on load', () => {
  withLocalStorageMap(
    {
      [SNAPSHOT_KEY]: JSON.stringify({
        sessions: [summary('s1')],
        transcript: {
          appSessionId: 's1',
          events: [{ ...event('huge', 1), text: 'x'.repeat(MAX_SNAPSHOT_TRANSCRIPT_BYTES + 1) }],
        },
      }),
    },
    () => {
      const snapshot = loadSessionSnapshot();
      assert.equal(snapshot?.transcript, undefined);
    },
  );
});

// ── Finding 4: one oversized session summary must not bypass the byte cap ──

test('a single oversized session summary is dropped on save', () => {
  const huge: SessionSummary = {
    ...summary('s1'),
    title: 'x'.repeat(MAX_SNAPSHOT_SUMMARY_BYTES + 1),
  };
  const snapshot = saveAndLoad([huge]);
  assert.equal(snapshot, undefined);
});

test('a single oversized session summary is dropped on load', () => {
  withLocalStorageMap(
    {
      [SNAPSHOT_KEY]: JSON.stringify({
        sessions: [{ ...summary('s1'), title: 'x'.repeat(MAX_SNAPSHOT_SUMMARY_BYTES + 1) }],
      }),
    },
    () => {
      assert.equal(loadSessionSnapshot(), undefined);
    },
  );
});
