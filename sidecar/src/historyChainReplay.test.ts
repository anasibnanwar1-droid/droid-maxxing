import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary } from './protocol.js';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-chain-replay-'));
process.env.HOME = home;

const {
  HistoryIndex,
  invalidateSessionIndex,
  invalidateSessionTranscripts,
  loadSessionTranscriptWindow,
  resolveSessionChain,
} = await import('./history.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

// These tests call loadSessionTranscriptWindow directly with hand-built
// chains, bypassing the resolveSessionChain self-heal that refreshes the
// memoized session index in production. Reset the memos (session index and
// parsed-transcript readers) so each test sees the files it just wrote,
// mirroring a freshly booted sidecar.
test.beforeEach(() => {
  invalidateSessionIndex();
  invalidateSessionTranscripts();
});

let clock = 0;
function assistant(text: string): string {
  clock += 1000;
  return JSON.stringify({
    type: 'message',
    id: `${text}-id`,
    timestamp: new Date(clock).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function assistantAt(text: string, ts: number): string {
  return JSON.stringify({
    type: 'message',
    id: `${text}-id`,
    timestamp: new Date(ts).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function compactionState(removedCount: number): string {
  clock += 1000;
  return JSON.stringify({
    type: 'compaction_state',
    id: `comp-${removedCount}`,
    timestamp: new Date(clock).toISOString(),
    removedCount,
    summaryText: 'summary of earlier turns',
    summaryKind: 'llm_summary',
  });
}

function writeSession(id: string, lines: string[]): void {
  const dir = join(home, '.factory', 'sessions', '2026', '06');
  mkdirSync(dir, { recursive: true });
  const all = [
    JSON.stringify({ type: 'session_start', id, cwd: home, sessionTitle: 'S' }),
    ...lines,
  ];
  writeFileSync(join(dir, `${id}.jsonl`), `${all.join('\n')}\n`);
}

// A chat compacted twice: s0 (original) -> s1 -> s2 (current backing).
function seedChain(): string[] {
  writeSession('s0', [assistant('a0-1'), assistant('a0-2')]);
  writeSession('s1', [compactionState(5), assistant('a1-1'), assistant('a1-2')]);
  writeSession('s2', [compactionState(7), assistant('a2-1'), assistant('a2-2')]);
  return ['s0', 's1', 's2'];
}

test('loadSessionTranscriptWindow replays the FULL compaction chain in order', () => {
  const chain = seedChain();
  const { events, olderCursor } = loadSessionTranscriptWindow('m', chain, { limit: 100 });

  const texts = events.filter((e) => e.kind === 'text').map((e) => e.text);
  assert.deepEqual(texts, ['a0-1', 'a0-2', 'a1-1', 'a1-2', 'a2-1', 'a2-2']);
  // The whole conversation fits in one window, so there is no older page.
  assert.equal(olderCursor, undefined);
});

test('each post-original chain segment surfaces a compaction divider with removedCount', () => {
  const chain = seedChain();
  const { events } = loadSessionTranscriptWindow('m', chain, { limit: 100 });

  const dividers = events.filter((e) => e.kind === 'compaction');
  assert.deepEqual(
    dividers.map((d) => d.removedCount),
    [5, 7],
  );
  // Divider sits immediately before the first message of its segment.
  const idxDivider5 = events.findIndex((e) => e.kind === 'compaction' && e.removedCount === 5);
  assert.equal(events[idxDivider5 + 1].text, 'a1-1');
});

test('cursor pages older history across the chain with no gaps or duplicates', () => {
  const chain = seedChain();
  const collected: string[] = [];
  const seenIds = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;

  do {
    const page = loadSessionTranscriptWindow('m', chain, { limit: 3, cursor });
    // Prepend each older page to rebuild the transcript oldest -> newest.
    collected.unshift(
      ...page.events.map((e) => (e.kind === 'compaction' ? `divider:${e.removedCount}` : e.text!)),
    );
    for (const e of page.events) {
      assert.ok(!seenIds.has(e.id), `duplicate event ${e.id} across pages`);
      seenIds.add(e.id);
    }
    cursor = page.olderCursor;
    pages += 1;
    assert.ok(pages < 10, 'pagination did not terminate');
  } while (cursor);

  assert.deepEqual(collected, [
    'a0-1',
    'a0-2',
    'divider:5',
    'a1-1',
    'a1-2',
    'divider:7',
    'a2-1',
    'a2-2',
  ]);
});

test('replayed events carry a monotonically increasing seq across the chain', () => {
  const chain = seedChain();
  const { events } = loadSessionTranscriptWindow('m', chain, { limit: 100 });

  assert.ok(
    events.every((e) => typeof e.seq === 'number'),
    'every replayed event must be stamped with a seq',
  );
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].seq! > events[i - 1].seq!, `seq must increase at index ${i}`);
  }
});

test('equal-timestamp events keep chain order via seq, not wall-clock', () => {
  // All three share one ts, so only seq disambiguates their order.
  writeSession('eqts', [
    assistantAt('first', 5000),
    assistantAt('second', 5000),
    assistantAt('third', 5000),
  ]);
  const { events } = loadSessionTranscriptWindow('m', ['eqts'], { limit: 100 });
  const texts = events.filter((e) => e.kind === 'text');

  assert.deepEqual(
    texts.map((e) => e.text),
    ['first', 'second', 'third'],
  );
  assert.equal(texts[0].ts, texts[2].ts);
  assert.ok(texts[0].seq! < texts[1].seq! && texts[1].seq! < texts[2].seq!);
});

test('an oversized compacted segment still surfaces its divider (read from the head)', () => {
  // > MAX_SESSION_BYTES so the transcript reader tail-windows the file; the
  // leading compaction_state must still be found by reading the head.
  const huge = 'x'.repeat(6_000_000);
  writeSession('orig', [assistant('first')]);
  writeSession('big', [compactionState(42), assistant('after-1'), assistant(huge)]);

  const { events } = loadSessionTranscriptWindow('m', ['orig', 'big'], { limit: 100 });
  const divider = events.find((e) => e.kind === 'compaction');
  assert.ok(divider, 'expected a compaction divider for the oversized segment');
  assert.equal(divider!.removedCount, 42);
});

test('a single (never-compacted) session yields no divider and no older cursor', () => {
  writeSession('solo', [assistant('only-1'), assistant('only-2')]);
  const { events, olderCursor } = loadSessionTranscriptWindow('m', ['solo'], { limit: 100 });

  assert.equal(events.filter((e) => e.kind === 'compaction').length, 0);
  assert.equal(olderCursor, undefined);
  assert.deepEqual(
    events.map((e) => e.text),
    ['only-1', 'only-2'],
  );
});

test('an in-place-compacted single segment still surfaces its divider', () => {
  // Chain length 1 (e.g. earlier files were pruned) but the only file begins
  // with a compaction_state: position can no longer flag it, so the divider
  // must be detected by reading the record itself.
  writeSession('inplace', [compactionState(9), assistant('after')]);
  const { events } = loadSessionTranscriptWindow('m', ['inplace'], { limit: 100 });

  const divider = events.find((e) => e.kind === 'compaction');
  assert.ok(divider, 'expected a divider for the in-place-compacted segment');
  assert.equal(divider!.removedCount, 9);
  assert.equal(events.find((e) => e.kind === 'text')?.text, 'after');
});

test('a mid-file compaction_state (in-place auto-compaction) replays as a divider in position', () => {
  // The daemon's auto-compaction appends the marker to the SAME session file,
  // so it lands between messages instead of at the head.
  writeSession('midfile', [
    assistant('before-1'),
    assistant('before-2'),
    compactionState(86),
    assistant('after-1'),
  ]);
  const { events } = loadSessionTranscriptWindow('m', ['midfile'], { limit: 100 });

  const kinds = events.map((e) => (e.kind === 'compaction' ? `divider:${e.removedCount}` : e.text));
  assert.deepEqual(kinds, ['before-1', 'before-2', 'divider:86', 'after-1']);
});

test('a leading compaction_state yields exactly one divider (head read deduped)', () => {
  writeSession('leadonly', [compactionState(11), assistant('m1')]);
  const { events } = loadSessionTranscriptWindow('m', ['leadonly'], { limit: 100 });

  const dividers = events.filter((e) => e.kind === 'compaction');
  assert.equal(dividers.length, 1);
  assert.equal(dividers[0].removedCount, 11);
});

test('resolveSessionChain rebuilds the chain from the persisted app-session row', () => {
  // Plain chats have no Mission Control directory, so the chain comes from sqlite
  // app-session row (original + previous backing ids + current), oldest first.
  writeSession('app0', [assistant('c0')]);
  writeSession('mid1', [compactionState(3), assistant('c1')]);
  writeSession('cur2', [compactionState(4), assistant('c2')]);
  const index = new HistoryIndex();
  index.syncSummaries([historicalSummary('app0', 'cur2', ['app0', 'mid1'])]);
  index.close();

  assert.deepEqual(resolveSessionChain('app0', 'cur2'), ['app0', 'mid1', 'cur2']);
  // Replaying that chain yields the full conversation in order.
  const { events } = loadSessionTranscriptWindow('app0', resolveSessionChain('app0', 'cur2'), {
    limit: 100,
  });
  assert.deepEqual(
    events.filter((e) => e.kind === 'text').map((e) => e.text),
    ['c0', 'c1', 'c2'],
  );
});

function historicalSummary(
  appSessionId: string,
  providerSessionId: string,
  compactedFromProviderSessionIds: string[],
): SessionSummary {
  return {
    appSessionId,
    providerSessionId,
    compactedFromProviderSessionIds,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: 'History chain',
    goal: '',
    cwd: home,
    workspaceKind: 'folder',
    autonomy: 'low',
    phase: 'paused',
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function sessionFilePath(id: string): string {
  return join(home, '.factory', 'sessions', '2026', '06', `${id}.jsonl`);
}

// chmod 0 does not block root reads; the memoization proofs below rely on
// reads failing.
const canBlockReads = process.getuid?.() !== 0;

test(
  'a memoized reader serves repeat pages without re-reading the file',
  { skip: !canBlockReads },
  () => {
    writeSession('memo1', [assistant('m1'), assistant('m2'), assistant('m3')]);
    const first = loadSessionTranscriptWindow('app', ['memo1'], { limit: 1 });
    assert.deepEqual(
      first.events.map((e) => e.text),
      ['m3'],
    );
    assert.ok(first.olderCursor);
    // Make the file unreadable: a re-read would throw, so a successful page
    // proves the memoized reader (validated by unchanged mtime + size)
    // served it from memory.
    chmodSync(sessionFilePath('memo1'), 0);
    try {
      const second = loadSessionTranscriptWindow('app', ['memo1'], {
        cursor: first.olderCursor,
        limit: 5,
      });
      assert.deepEqual(
        second.events.map((e) => e.text),
        ['m1', 'm2'],
      );
      assert.equal(second.olderCursor, undefined);
    } finally {
      chmodSync(sessionFilePath('memo1'), 0o644);
    }
  },
);

test('a live-appended session file invalidates the memoized reader', () => {
  writeSession('live1', [assistant('l1')]);
  const first = loadSessionTranscriptWindow('app', ['live1'], { limit: 10 });
  assert.deepEqual(
    first.events.map((e) => e.text),
    ['l1'],
  );
  appendFileSync(sessionFilePath('live1'), `${assistant('l2')}\n`);
  const second = loadSessionTranscriptWindow('app', ['live1'], { limit: 10 });
  assert.deepEqual(
    second.events.map((e) => e.text),
    ['l1', 'l2'],
  );
});

test('pre-v2 cursors end paging cleanly instead of serving a wrong page', () => {
  seedChain();
  // The pre-v2 "<ci>:end" form still maps to a segment tail.
  const legacy = loadSessionTranscriptWindow('app', ['s0', 's1', 's2'], {
    cursor: '1:end',
    limit: 3,
  });
  assert.deepEqual(
    legacy.events.filter((e) => e.kind === 'text').map((e) => e.text),
    ['a1-1', 'a1-2'],
  );
  // Item-index cursors no longer address anything: empty page, no cursor.
  const stale = loadSessionTranscriptWindow('app', ['s0', 's1', 's2'], {
    cursor: '2:1',
    limit: 10,
  });
  assert.deepEqual(stale.events, []);
  assert.equal(stale.olderCursor, undefined);
});

test('parsed-transcript readers are LRU-bounded', { skip: !canBlockReads }, () => {
  // MAX_TRANSCRIPT_READERS is 12; the 13th distinct session evicts the
  // first, so paging it must re-read (and fail on the unreadable file)
  // while a still-cached session keeps serving from memory. All files are
  // written up front because the session index memoizes after first use.
  for (let i = 0; i < 13; i++) writeSession(`lru${i}`, [assistant(`lru-${i}`)]);
  for (let i = 0; i < 13; i++) loadSessionTranscriptWindow('app', [`lru${i}`], { limit: 1 });
  chmodSync(sessionFilePath('lru0'), 0);
  try {
    assert.throws(() => loadSessionTranscriptWindow('app', ['lru0'], { limit: 1 }));
  } finally {
    chmodSync(sessionFilePath('lru0'), 0o644);
  }
  chmodSync(sessionFilePath('lru12'), 0);
  try {
    const page = loadSessionTranscriptWindow('app', ['lru12'], { limit: 1 });
    assert.deepEqual(
      page.events.map((e) => e.text),
      ['lru-12'],
    );
  } finally {
    chmodSync(sessionFilePath('lru12'), 0o644);
  }
});
