import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ChildSessionSummary,
  ServerEvent,
  SessionHistoryEntry,
  SessionSummary,
  TranscriptEvent,
} from './protocol.js';
import {
  SessionTimeline,
  type SessionTimelineLoaders,
  type SessionTimelineRegistry,
} from './SessionTimeline.js';

interface HarnessOptions {
  summaries?: SessionSummary[];
  liveAppSessionIds?: string[];
  childSessions?: ChildSessionSummary[];
  loaders?: Partial<SessionTimelineLoaders>;
  now?: () => number;
  onRecordEvent?: (event: TranscriptEvent) => void;
}

function createHarness(options: HarnessOptions = {}) {
  const emitted: ServerEvent[] = [];
  const errors: Array<Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>> = [];
  const recorded: TranscriptEvent[] = [];
  const trace: string[] = [];
  const summaries = options.summaries ?? [];
  const liveAppSessionIds = new Set(options.liveAppSessionIds ?? []);
  const loaders: SessionTimelineLoaders = {
    list: () => [],
    page: () => ({ events: [] }),
    hydrateMission: () => ({ progress: [], transcripts: [] }),
    resolveChain: (_appSessionId, providerSessionId) => [providerSessionId],
    transcriptWindow: () => ({ events: [] }),
    ...options.loaders,
  };
  const registry: SessionTimelineRegistry = {
    resolveSummary: (id) =>
      summaries.find(
        (summary) =>
          summary.appSessionId === id ||
          summary.providerSessionId === id ||
          summary.compactedFromProviderSessionIds?.includes(id),
      ),
    getLive: (id) => (liveAppSessionIds.has(id) ? true : undefined),
  };
  const timeline = new SessionTimeline({
    registry,
    history: {
      recordEvent: (event) => {
        trace.push(`record:${event.id}`);
        options.onRecordEvent?.(event);
        recorded.push(event);
      },
    },
    getChildSessions: () => options.childSessions ?? [],
    emit: (event) => {
      trace.push(`emit:${event.type}`);
      emitted.push(event);
    },
    emitError: (error) => {
      errors.push(error);
    },
    loaders,
    ...(options.now ? { now: options.now } : {}),
  });
  return { emitted, errors, recorded, timeline, trace };
}

function summary(
  appSessionId: string,
  providerSessionId: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    appSessionId,
    providerSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: appSessionId,
    goal: appSessionId,
    cwd: '/workspace',
    workspaceKind: 'folder',
    autonomy: 'low',
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
    compacting: overrides.compacting ?? false,
  };
}

function child(
  parentAppSessionId: string,
  childSessionId: string,
  status: ChildSessionSummary['status'],
): ChildSessionSummary {
  return {
    parentAppSessionId,
    childSessionId,
    role: 'worker',
    status,
    modelId: 'model-default',
    transcriptAvailable: true,
  };
}

function transcript(id: string, appSessionId = 'provider-source'): TranscriptEvent {
  return {
    id,
    appSessionId,
    sourceSessionId: appSessionId,
    role: 'primary',
    ts: 1,
    kind: 'text',
    text: id,
  };
}

function historyEntry(providerSessionId: string, modifiedTime: number): SessionHistoryEntry {
  return {
    providerSessionId,
    title: providerSessionId,
    modifiedTime,
    createdTime: 1,
    messageCount: 1,
  };
}

test('append records before emitting exactly one live transcript event', () => {
  const { emitted, recorded, timeline, trace } = createHarness();
  const event = transcript('event-1', 'app-1');

  timeline.append(event);

  assert.deepEqual(trace, ['record:event-1', 'emit:event.appended']);
  assert.deepEqual(recorded, [event]);
  assert.deepEqual(emitted, [{ type: 'event.appended', event }]);
});

test('plain restore resolves aliases, records in order, and emits replace telemetry', () => {
  const restored = [transcript('first'), transcript('second')];
  const childSessions = [child('app-1', 'worker-1', 'running')];
  const calls: unknown[][] = [];
  const stable = summary('app-1', 'provider-current', {
    compactedFromProviderSessionIds: ['provider-old'],
  });
  const harness = createHarness({
    summaries: [stable],
    childSessions,
    loaders: {
      resolveChain: (...args) => {
        calls.push(args);
        return ['provider-old', 'provider-current'];
      },
      transcriptWindow: (...args) => {
        calls.push(args);
        return { events: restored, olderCursor: 'older-1' };
      },
    },
  });

  harness.timeline.load('provider-old');

  assert.deepEqual(calls, [
    ['app-1', 'provider-current'],
    ['app-1', ['provider-old', 'provider-current'], { cursor: undefined }],
  ]);
  assert.deepEqual(
    harness.recorded.map((event) => [event.id, event.appSessionId]),
    [
      ['first', 'app-1'],
      ['second', 'app-1'],
    ],
  );
  assert.deepEqual(harness.trace, ['record:first', 'record:second', 'emit:session.history']);
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal(page.appSessionId, 'app-1');
  assert.equal(page.mode, 'replace');
  assert.equal(page.olderCursor, 'older-1');
  assert.equal(page.loadedCount, 2);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.childSessions, childSessions);
});

test('Mission Control restore preserves progress, child links, cursor, identity, and order', () => {
  const progress = [{ type: 'feature', timestamp: '2026-07-28T00:00:00.000Z' }];
  const restored = [transcript('mission-first'), transcript('mission-second')];
  const childSessions = [child('mission-app', 'mission-worker', 'running')];
  const calls: unknown[][] = [];
  const harness = createHarness({
    summaries: [summary('mission-app', 'mission-provider', { sessionPurpose: 'mission-control' })],
    childSessions,
    loaders: {
      hydrateMission: (...args) => {
        calls.push(args);
        return { progress, transcripts: restored, olderCursor: 'mission-older' };
      },
      resolveChain: () => {
        throw new Error('plain restore must not run');
      },
    },
  });

  harness.timeline.load('mission-provider');

  assert.deepEqual(calls, [['mission-app', { cursor: undefined }]]);
  assert.deepEqual(
    harness.recorded.map((event) => event.id),
    ['mission-first', 'mission-second'],
  );
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal(page.appSessionId, 'mission-app');
  assert.deepEqual(page.progress, progress);
  assert.deepEqual(page.childSessions, childSessions);
  assert.equal(page.olderCursor, 'mission-older');
  assert.equal(page.mode, 'replace');
});

test('older restore prepends only transcripts and preserves page telemetry', () => {
  let childLinkReads = 0;
  const event = transcript('older');
  const harness = createHarness({
    summaries: [summary('app-1', 'provider-1')],
    loaders: {
      transcriptWindow: (_appSessionId, _chain, options) => {
        assert.deepEqual(options, { cursor: 'cursor-1' });
        return { events: [event], olderCursor: 'cursor-2' };
      },
    },
  });
  const timeline = new SessionTimeline({
    registry: {
      resolveSummary: () => summary('app-1', 'provider-1'),
      getLive: () => undefined,
    },
    history: { recordEvent: (recorded) => harness.recorded.push(recorded) },
    getChildSessions: () => {
      childLinkReads += 1;
      return [];
    },
    emit: (emitted) => harness.emitted.push(emitted),
    emitError: (error) => harness.errors.push(error),
    loaders: {
      list: () => [],
      page: () => ({ events: [] }),
      hydrateMission: () => ({ progress: [], transcripts: [] }),
      resolveChain: () => ['provider-1'],
      transcriptWindow: (_appSessionId, _chain, options) => {
        assert.deepEqual(options, { cursor: 'cursor-1' });
        return { events: [event], olderCursor: 'cursor-2' };
      },
    },
  });

  timeline.load('provider-1', 'cursor-1');

  assert.equal(childLinkReads, 0);
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal(page.mode, 'prepend');
  assert.deepEqual(page.progress, []);
  assert.equal(page.childSessions, undefined);
  assert.equal(page.olderCursor, 'cursor-2');
  assert.equal(page.loadedCount, 1);
  assert.equal(page.hasMore, true);
});

test('older failure emits an empty terminal prepend without an error', () => {
  const harness = createHarness({
    summaries: [summary('app-1', 'provider-1')],
    loaders: {
      transcriptWindow: () => {
        throw new Error('read failed');
      },
    },
  });

  harness.timeline.load('provider-1', 'cursor-1');

  assert.equal(harness.errors.length, 0);
  assert.equal(harness.emitted.length, 1);
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal(page.mode, 'prepend');
  assert.deepEqual(page.transcripts, []);
  assert.equal(page.olderCursor, undefined);
  assert.equal(page.hasMore, false);
});

test('missing live history emits an authoritative empty replace page', () => {
  const childSessions = [child('app-live', 'worker-live', 'running')];
  const harness = createHarness({
    summaries: [summary('app-live', 'provider-live')],
    liveAppSessionIds: ['app-live'],
    childSessions,
    loaders: { resolveChain: () => [] },
  });

  harness.timeline.load('provider-live');

  assert.equal(harness.errors.length, 0);
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal(page.mode, 'replace');
  assert.deepEqual(page.transcripts, []);
  assert.deepEqual(page.childSessions, childSessions);
  assert.equal(page.loadedCount, 0);
  assert.equal(page.hasMore, false);
});

test('non-live failure emits stable recoverable errors and permits retry', () => {
  let fail = true;
  const harness = createHarness({
    summaries: [summary('stable-app', 'provider-current')],
    loaders: {
      transcriptWindow: () => {
        if (fail) throw new Error('temporarily unavailable');
        return { events: [transcript('retry-success')] };
      },
    },
  });

  harness.timeline.load('provider-current');
  assert.equal(harness.emitted[0]?.type, 'session.history.error');
  assert.deepEqual(harness.errors, [
    {
      appSessionId: 'stable-app',
      providerSessionId: 'provider-current',
      message: 'temporarily unavailable',
      recoverable: true,
    },
  ]);

  fail = false;
  harness.timeline.load('provider-current');
  assert.equal(harness.emitted.at(-1)?.type, 'session.history');
});

test('recording failure prevents a history page after a partial write', () => {
  const harness = createHarness({
    summaries: [summary('stable-app', 'provider-current')],
    loaders: {
      transcriptWindow: () => ({
        events: [transcript('recorded-first'), transcript('recording-fails')],
      }),
    },
    onRecordEvent: (event) => {
      if (event.id === 'recording-fails') throw new Error('index unavailable');
    },
  });

  harness.timeline.load('provider-current');

  assert.deepEqual(
    harness.recorded.map((event) => event.id),
    ['recorded-first'],
  );
  assert.equal(
    harness.emitted.some((event) => event.type === 'session.history'),
    false,
  );
  assert.equal(harness.emitted[0]?.type, 'session.history.error');
  assert.deepEqual(harness.errors, [
    {
      appSessionId: 'stable-app',
      providerSessionId: 'provider-current',
      message: 'index unavailable',
      recoverable: true,
    },
  ]);
});

test('legacy provider pages keep their shape, identity, order, limit, and error behavior', () => {
  const calls: unknown[][] = [];
  let fail = false;
  const events = [transcript('page-first'), transcript('page-second')];
  const harness = createHarness({
    summaries: [summary('stable-app', 'provider-current')],
    loaders: {
      page: (...args) => {
        calls.push(args);
        if (fail) throw new Error('page failed');
        return { events };
      },
    },
  });

  harness.timeline.loadProviderPage('stable-app', '40', 25);

  assert.deepEqual(calls[0], ['provider-current', 'stable-app', '40', 25]);
  assert.deepEqual(
    harness.recorded.map((event) => event.id),
    ['page-first', 'page-second'],
  );
  const page = harness.emitted[0];
  assert.equal(page?.type, 'session.history');
  if (page?.type !== 'session.history') return;
  assert.equal('mode' in page, false);
  assert.equal('loadedCount' in page, false);

  fail = true;
  harness.timeline.loadProviderPage('provider-current');
  assert.deepEqual(harness.errors.at(-1), {
    appSessionId: 'stable-app',
    providerSessionId: 'provider-current',
    message: 'page failed',
  });
});

test('child replay uses the live append path and silently tolerates missing history', () => {
  let fail = false;
  const events = [transcript('child-first'), transcript('child-second')];
  const harness = createHarness({
    loaders: {
      page: (providerSessionId, appSessionId, cursor, limit) => {
        assert.deepEqual(
          [providerSessionId, appSessionId, cursor, limit],
          ['child-provider', 'app-1', undefined, 200],
        );
        if (fail) throw new Error('not flushed');
        return { events };
      },
    },
  });

  harness.timeline.replayChild('app-1', 'child-logical', 'child-provider');

  assert.deepEqual(harness.trace, [
    'record:child-first',
    'emit:event.appended',
    'record:child-second',
    'emit:event.appended',
  ]);
  assert.deepEqual(
    harness.emitted.map((event) =>
      event.type === 'event.appended'
        ? [event.event.appSessionId, event.event.sourceSessionId]
        : null,
    ),
    [
      ['app-1', 'child-logical'],
      ['app-1', 'child-logical'],
    ],
  );
  fail = true;
  harness.timeline.replayChild('app-1', 'child-logical', 'child-provider');
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.emitted.length, 2);
});

test('status appends keep unique IDs, clock behavior, compact type, source, and role', () => {
  const times = [100, 101, 100, 101];
  const harness = createHarness({ now: () => times.shift() ?? 0 });

  harness.timeline.appendStatus('app-1', 'first', 'auto', 'worker-1', 'worker');
  harness.timeline.appendStatus('app-1', 'second', undefined, 'validator-1', 'validator');

  assert.equal(harness.recorded.length, 2);
  const [first, second] = harness.recorded;
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first, {
    id: 'status-2s-0',
    appSessionId: 'app-1',
    sourceSessionId: 'worker-1',
    role: 'worker',
    ts: 101,
    kind: 'status',
    text: 'first',
    compactType: 'auto',
  });
  assert.equal(second.sourceSessionId, 'validator-1');
  assert.equal(second.role, 'validator');
  assert.equal(second.compactType, undefined);
});

test('history listing preserves loader ordering and reports loader failures', () => {
  const sessions = [historyEntry('newer', 2), historyEntry('older', 1)];
  let fail = false;
  const harness = createHarness({
    loaders: {
      list: () => {
        if (fail) throw new Error('list failed');
        return sessions;
      },
    },
  });

  harness.timeline.list();
  assert.deepEqual(harness.emitted, [{ type: 'history.list', sessions }]);

  fail = true;
  harness.timeline.list();
  assert.deepEqual(harness.errors, [{ message: 'list failed' }]);
});
