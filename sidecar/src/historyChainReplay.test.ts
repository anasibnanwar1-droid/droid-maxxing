import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-chain-replay-'));
process.env.HOME = home;

const { loadMissionTranscriptWindow, resolveSessionChain } = await import('./history.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
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

test('loadMissionTranscriptWindow replays the FULL compaction chain in order', () => {
  const chain = seedChain();
  const { events, olderCursor } = loadMissionTranscriptWindow('m', chain, { limit: 100 });

  const texts = events.filter((e) => e.kind === 'text').map((e) => e.text);
  assert.deepEqual(texts, ['a0-1', 'a0-2', 'a1-1', 'a1-2', 'a2-1', 'a2-2']);
  // The whole conversation fits in one window, so there is no older page.
  assert.equal(olderCursor, undefined);
});

test('each post-original chain segment surfaces a compaction divider with removedCount', () => {
  const chain = seedChain();
  const { events } = loadMissionTranscriptWindow('m', chain, { limit: 100 });

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
    const page = loadMissionTranscriptWindow('m', chain, { limit: 3, cursor });
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

test('an oversized compacted segment still surfaces its divider (read from the head)', () => {
  // > MAX_SESSION_BYTES so the transcript reader tail-windows the file; the
  // leading compaction_state must still be found by reading the head.
  const huge = 'x'.repeat(6_000_000);
  writeSession('orig', [assistant('first')]);
  writeSession('big', [compactionState(42), assistant('after-1'), assistant(huge)]);

  const { events } = loadMissionTranscriptWindow('m', ['orig', 'big'], { limit: 100 });
  const divider = events.find((e) => e.kind === 'compaction');
  assert.ok(divider, 'expected a compaction divider for the oversized segment');
  assert.equal(divider!.removedCount, 42);
});

test('a single (never-compacted) session yields no divider and no older cursor', () => {
  writeSession('solo', [assistant('only-1'), assistant('only-2')]);
  const { events, olderCursor } = loadMissionTranscriptWindow('m', ['solo'], { limit: 100 });

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
  const { events } = loadMissionTranscriptWindow('m', ['inplace'], { limit: 100 });

  const divider = events.find((e) => e.kind === 'compaction');
  assert.ok(divider, 'expected a divider for the in-place-compacted segment');
  assert.equal(divider!.removedCount, 9);
  assert.equal(events.find((e) => e.kind === 'text')?.text, 'after');
});

test('resolveSessionChain rebuilds the chain from the persisted app-session row', () => {
  // Plain chats have no mission dir, so the chain must come from the sqlite
  // app-session row (original + previous backing ids + current), oldest first.
  writeSession('app0', [assistant('c0')]);
  writeSession('mid1', [compactionState(3), assistant('c1')]);
  writeSession('cur2', [compactionState(4), assistant('c2')]);
  const dbDir = join(home, '.factory', 'droid-control');
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(join(dbDir, 'index.sqlite'));
  db.exec(
    'CREATE TABLE app_sessions (app_session_id TEXT, droid_session_id TEXT, previous_droid_session_ids TEXT)',
  );
  db.prepare(
    'INSERT INTO app_sessions (app_session_id, droid_session_id, previous_droid_session_ids) VALUES (?, ?, ?)',
  ).run('app0', 'cur2', JSON.stringify(['app0', 'mid1']));
  db.close();

  assert.deepEqual(resolveSessionChain('app0', 'cur2'), ['app0', 'mid1', 'cur2']);
  // Replaying that chain yields the full conversation in order.
  const { events } = loadMissionTranscriptWindow('app0', resolveSessionChain('app0', 'cur2'), {
    limit: 100,
  });
  assert.deepEqual(
    events.filter((e) => e.kind === 'text').map((e) => e.text),
    ['c0', 'c1', 'c2'],
  );
});
