import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SESSION_BYTES,
  SessionTranscriptReader,
  parseFullSessionTranscript,
  type TranscriptWindowCursor,
} from './sessionTranscript.js';
import type { TranscriptEvent } from './protocol.js';

const dir = mkdtempSync(join(tmpdir(), 'droid-transcript-'));
let fileCount = 0;

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

let clock = 0;
function sessionStart(id: string): string {
  return JSON.stringify({ type: 'session_start', id, cwd: dir, sessionTitle: 'S' });
}

function assistant(text: string): string {
  clock += 1000;
  return JSON.stringify({
    type: 'message',
    id: `${text}-id`,
    timestamp: new Date(clock).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function userMessage(text: string, visibility?: 'llm_only' | 'user_only' | 'both'): string {
  clock += 1000;
  return JSON.stringify({
    type: 'message',
    id: `${text}-id`,
    timestamp: new Date(clock).toISOString(),
    message: {
      role: 'user',
      ...(visibility ? { visibility } : {}),
      content: [{ type: 'text', text }],
    },
  });
}

// One stored line that yields THREE events (thinking + text + tool_call), so
// page boundaries can split it.
function rich(id: string): string {
  clock += 1000;
  return JSON.stringify({
    type: 'message',
    id,
    timestamp: new Date(clock).toISOString(),
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: `${id}-think` },
        { type: 'text', text: `${id}-text` },
        { type: 'tool_use', name: 'Read', id: `${id}-tool`, input: {} },
      ],
    },
  });
}

function compactionState(removedCount: number): string {
  clock += 1000;
  return JSON.stringify({
    type: 'compaction_state',
    id: `comp-${removedCount}`,
    timestamp: new Date(clock).toISOString(),
    removedCount,
  });
}

function writeSession(lines: string[]): string {
  fileCount += 1;
  const path = join(dir, `s${fileCount}.jsonl`);
  writeFileSync(path, `${[sessionStart(`s${fileCount}`), ...lines].join('\n')}\n`);
  return path;
}

function reader(path: string): SessionTranscriptReader {
  return new SessionTranscriptReader('app', 'provider', path, 'primary');
}

// Collect every page newest -> oldest and rebuild the full forward transcript.
function collectAll(path: string, limit: number): TranscriptEvent[] {
  const r = reader(path);
  const pages: TranscriptEvent[][] = [];
  let from: TranscriptWindowCursor | undefined;
  let guard = 0;
  do {
    const window = r.windowBackward(limit, 0, from);
    pages.unshift(window.events);
    from = window.older;
    guard += 1;
    assert.ok(guard < 100, 'pagination did not terminate');
  } while (from);
  return pages.flat();
}

test('backward windows reassemble the exact transcript with no gaps or duplicates', () => {
  const path = writeSession([assistant('a1'), rich('r'), assistant('a2'), assistant('a3')]);
  const all = collectAll(path, 4);
  assert.deepEqual(
    all.map((e) => `${e.kind}:${e.text ?? e.toolName ?? ''}`),
    ['text:a1', 'thinking:r-think', 'text:r-text', 'tool_call:Read', 'text:a2', 'text:a3'],
  );
});

test("a page boundary may split one line's events across pages", () => {
  const path = writeSession([assistant('a1'), rich('r'), assistant('a2')]);
  const r = reader(path);
  const page1 = r.windowBackward(2, 0);
  assert.deepEqual(
    page1.events.map((e) => e.text ?? e.toolName),
    ['Read', 'a2'],
  );
  assert.ok(page1.older, 'expected an older cursor mid-line');
  const page2 = r.windowBackward(2, 0, page1.older);
  assert.deepEqual(
    page2.events.map((e) => e.text),
    ['r-think', 'r-text'],
  );
  const page3 = r.windowBackward(2, 0, page2.older);
  assert.deepEqual(
    page3.events.map((e) => e.text),
    ['a1'],
  );
  assert.equal(page3.older, undefined);
});

test('seq is strictly increasing within and across pages', () => {
  const path = writeSession([
    assistant('a1'),
    rich('r'),
    assistant('a2'),
    assistant('a3'),
    assistant('a4'),
  ]);
  const all = collectAll(path, 2);
  assert.ok(all.every((e) => typeof e.seq === 'number'));
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i].seq! > all[i - 1].seq!, `seq must increase at index ${i}`);
  }
});

test('corrupt lines are skipped without losing their neighbors', () => {
  const path = writeSession([assistant('a1'), '{not json', assistant('a2')]);
  const all = collectAll(path, 10);
  assert.deepEqual(
    all.map((e) => e.text),
    ['a1', 'a2'],
  );
});

test('LLM-only user messages stay hidden in eager and paged transcript replay', () => {
  const path = writeSession([
    userMessage('ordinary user prompt'),
    userMessage('internal child-session handoff', 'llm_only'),
    userMessage('user-only prompt', 'user_only'),
    userMessage('shared prompt', 'both'),
    assistant('assistant reply'),
  ]);

  for (const events of [
    collectAll(path, 2),
    parseFullSessionTranscript('app', 'provider', path, 'primary'),
  ]) {
    assert.deepEqual(
      events.map((event) => event.text),
      ['ordinary user prompt', 'user-only prompt', 'shared prompt', 'assistant reply'],
    );
  }
});

test('a leading compaction_state surfaces exactly one divider at the very top', () => {
  const path = writeSession([compactionState(9), assistant('after-1'), assistant('after-2')]);
  const r = reader(path);
  const page1 = r.windowBackward(2, 0);
  assert.deepEqual(
    page1.events.map((e) => e.text),
    ['after-1', 'after-2'],
  );
  assert.ok(page1.older, 'divider still unserved');
  const page2 = r.windowBackward(2, 0, page1.older);
  const dividers = page2.events.filter((e) => e.kind === 'compaction');
  assert.equal(dividers.length, 1);
  assert.equal(dividers[0].removedCount, 9);
  assert.equal(page2.older, undefined);
});

test('a leading compaction_state without a timestamp still dedupes to one divider', () => {
  // Regression: ts=0 compaction events must feed the head-dedupe set — the
  // old eager parser matched `e.ts === comp.ts`, where 0 === 0 holds, but a
  // truthiness guard on the reader's set-add would emit the divider twice.
  const noTimestamp = JSON.stringify({ type: 'compaction_state', id: 'comp-0', removedCount: 7 });
  const path = writeSession([noTimestamp, assistant('after')]);
  const dividers = collectAll(path, 100).filter((e) => e.kind === 'compaction');
  assert.equal(dividers.length, 1);
  assert.equal(dividers[0].removedCount, 7);
});

test('a non-object JSONL literal in the head does not crash the reader', () => {
  // Regression: readCompactionState dereferenced row.type on every parsed
  // row, so a syntactically valid `null` (or number/boolean/array) literal
  // between session_start and compaction_state threw and aborted reader
  // construction. Non-object rows are noise and must be skipped.
  const path = writeSession(['null', '42', compactionState(9), assistant('after')]);
  assert.doesNotThrow(() => reader(path));
  const dividers = collectAll(path, 100).filter((e) => e.kind === 'compaction');
  assert.equal(dividers.length, 1);
  assert.equal(dividers[0].removedCount, 9);
});

test('an oversized file serves the tail first and the trim status + divider only at the top', () => {
  // ~6 MB across many lines so the tail window holds whole newer lines.
  const filler = 'x'.repeat(30_000);
  const lines: string[] = [compactionState(42)];
  for (let i = 0; i < 200; i++) lines.push(assistant(`${i}-${filler}`));
  const path = writeSession(lines);

  const r = reader(path);
  const first = r.windowBackward(3, 0);
  assert.equal(first.events.length, 3);
  assert.ok(first.events.every((e) => e.kind === 'text'));
  assert.ok(first.older, 'expected more history below the first window');

  // Walk to the top: the last page must carry the head-read divider and the
  // oversized-trim status, divider first (matching the eager-reader order).
  let from: TranscriptWindowCursor | undefined = first.older;
  let top: TranscriptEvent[] = [];
  let guard = 0;
  while (from) {
    const window = r.windowBackward(500, 0, from);
    top = window.events;
    from = window.older;
    guard += 1;
    assert.ok(guard < 20, 'pagination did not terminate');
  }
  assert.equal(top[0]?.kind, 'compaction');
  assert.equal(top[0]?.removedCount, 42);
  assert.equal(top[1]?.kind, 'status');
  assert.match(top[1]?.text ?? '', /oversized session/);
  // The divider exists exactly once across the whole walk.
  const all = collectAll(path, 500);
  assert.equal(all.filter((e) => e.kind === 'compaction').length, 1);
  assert.equal(all.filter((e) => e.kind === 'status').length, 1);
});

test('parseFullSessionTranscript stays eager: trim status first, no head-read divider', () => {
  const filler = 'y'.repeat(30_000);
  const lines: string[] = [compactionState(7)];
  for (let i = 0; i < 200; i++) lines.push(assistant(`${i}-${filler}`));
  const path = writeSession(lines);

  const events = parseFullSessionTranscript('app', 'provider', path, 'primary');
  assert.equal(events[0]?.kind, 'status');
  // The leading compaction_state was tail-windowed away, and the eager parse
  // does not head-read it back (loadSessionPage behavior is unchanged).
  assert.equal(events.filter((e) => e.kind === 'compaction').length, 0);
  assert.ok(events.some((e) => e.kind === 'text'));
});

test('parseFullSessionTranscript replays a mid-file compaction marker in position', () => {
  const path = writeSession([assistant('before'), compactionState(3), assistant('after')]);
  const events = parseFullSessionTranscript('app', 'provider', path, 'primary');
  assert.deepEqual(
    events.map((e) => (e.kind === 'compaction' ? `divider:${e.removedCount}` : e.text)),
    ['before', 'divider:3', 'after'],
  );
});

test('MAX_SESSION_BYTES tail window drops the partial first line', () => {
  // A single message whose text spans the window boundary must not parse.
  const huge = 'z'.repeat(MAX_SESSION_BYTES + 1000);
  const path = writeSession([assistant(huge), assistant('tail')]);
  const all = collectAll(path, 100);
  assert.deepEqual(
    all.filter((e) => e.kind === 'text').map((e) => e.text),
    ['tail'],
  );
});
