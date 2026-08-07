import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-history-index-home-'));
process.env.HOME = home;

const {
  HistoryIndex,
  invalidateSessionIndex,
  loadSessionHistory,
  loadSessionPage,
  loadSessionTranscriptWindow,
  resolveSessionChain,
  warmSessionIndex,
} = await import('./history.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function writeSession(id: string, text?: string): string {
  const dir = join(home, '.factory', 'sessions');
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'session_start',
      cwd: '',
      sessionTitle: `Chat ${id}`,
      settings: { interactionMode: 'auto' },
    }),
  ];
  if (text !== undefined) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `m-${id}`,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text }] },
      }),
    );
  }
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

test('resolveSessionChain finds a session file created after the index was memoized', () => {
  invalidateSessionIndex();
  const first = nextId('idx-first');
  writeSession(first);
  assert.deepEqual(resolveSessionChain(first, first), [first]);

  // A session started after the first lookup must not read as missing: the
  // memoized index rebuilds once on a miss instead of requiring a restart.
  const later = nextId('idx-later');
  writeSession(later);
  assert.deepEqual(resolveSessionChain(later, later), [later]);
  assert.deepEqual(resolveSessionChain(first, first), [first]);
});

test('resolveSessionChain returns an empty chain for a session that exists nowhere', () => {
  invalidateSessionIndex();
  assert.deepEqual(resolveSessionChain('idx-unknown', 'idx-unknown'), []);
});

test('loadSessionPage pages a session file created after the index was memoized', () => {
  invalidateSessionIndex();
  const first = nextId('page-first');
  writeSession(first, 'first');
  loadSessionPage(first, first);

  const later = nextId('page-later');
  writeSession(later, 'later hello');
  const page = loadSessionPage(later, later);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0]?.kind, 'text');
});

test('loadSessionPage still rejects a session that exists nowhere', () => {
  invalidateSessionIndex();
  assert.throws(() => loadSessionPage('page-missing', 'page-missing'), /not found/);
});

test('loadSessionHistory reuses the memoized index until invalidateSessionIndex', () => {
  invalidateSessionIndex();
  const first = nextId('list-first');
  writeSession(first);
  const before = loadSessionHistory().length;

  const later = nextId('list-later');
  writeSession(later);
  assert.equal(loadSessionHistory().length, before, 'memoized index does not rescan');
  invalidateSessionIndex();
  assert.equal(loadSessionHistory().length, before + 1, 'invalidation forces a rescan');
});

test('warmSessionIndex prebuilds the memo so later enumeration is frozen', () => {
  invalidateSessionIndex();
  warmSessionIndex();
  const id = nextId('warm');
  writeSession(id);
  // Written after the warm: invisible to the plain memoized enumeration...
  assert.equal(
    loadSessionHistory().some((row) => row.providerSessionId === id),
    false,
  );
  // ...but a targeted lookup still self-heals and finds it.
  assert.deepEqual(resolveSessionChain(id, id), [id]);
});

test('loadSessionTranscriptWindow serves repeat loads through the memoized index', () => {
  invalidateSessionIndex();
  const id = nextId('window');
  writeSession(id, 'windowed hello');
  const chain = resolveSessionChain(id, id);
  const first = loadSessionTranscriptWindow(id, chain);
  assert.equal(first.events.length, 1);
  const repeat = loadSessionTranscriptWindow(id, chain);
  assert.equal(repeat.events.length, 1);
  assert.equal(repeat.events[0]?.id, first.events[0]?.id);
});

test('reconcileSessionFiles invalidates the index after a session file is removed', () => {
  invalidateSessionIndex();
  const id = nextId('memo-removed');
  writeSession(id, 'about to be removed');
  const index = new HistoryIndex();
  try {
    // Populate the file cache so a later deletion is detected as a change...
    index.reconcileSessionFiles();
    // ...then build the lifetime session index memo with the file present.
    assert.deepEqual(resolveSessionChain(id, id), [id]);

    // Remove the file and reconcile: the cache detects the deletion and the
    // memo must drop the now-stale id -> path so a transcript load resolves
    // nothing instead of following a path that no longer exists.
    rmSync(join(home, '.factory', 'sessions', `${id}.jsonl`));
    assert.equal(index.reconcileSessionFiles(), 1, 'the deleted file is reconciled away');
    const window = loadSessionTranscriptWindow(id, [id]);
    assert.equal(window.events.length, 0, 'a removed session resolves no transcript');
  } finally {
    index.close();
  }
});

test('targeted reconciliation invalidates history enumeration for creation and deletion', () => {
  invalidateSessionIndex();
  warmSessionIndex();
  const id = nextId('targeted-memo');
  const path = writeSession(id, 'external session');
  const index = new HistoryIndex();
  try {
    assert.equal(
      index.reconcileSessionFilePaths([{ providerSessionId: id, path }]),
      1,
      'the new file enters the cache',
    );
    assert.equal(
      loadSessionHistory().some((row) => row.providerSessionId === id),
      true,
      'targeted creation refreshes history enumeration',
    );

    rmSync(path);
    assert.equal(
      index.reconcileSessionFilePaths([{ providerSessionId: id, path }]),
      1,
      'the removed file leaves the cache',
    );
    assert.equal(
      loadSessionHistory().some((row) => row.providerSessionId === id),
      false,
      'targeted deletion refreshes history enumeration',
    );
  } finally {
    index.close();
  }
});
