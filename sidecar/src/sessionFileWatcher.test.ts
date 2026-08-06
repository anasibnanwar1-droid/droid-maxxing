import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sessionIdFromSessionFileName, startSessionFileWatcher } from './sessionFileWatcher.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for watcher condition');
    await delay(10);
  }
}

test('sessionIdFromSessionFileName extracts the provider session id', () => {
  assert.equal(sessionIdFromSessionFileName('encoded-cwd/dir/abc-123.jsonl'), 'abc-123');
  assert.equal(sessionIdFromSessionFileName('abc-123.jsonl'), 'abc-123');
  assert.equal(sessionIdFromSessionFileName('encoded-cwd\\dir\\abc-123.jsonl'), 'abc-123');
  assert.equal(sessionIdFromSessionFileName('encoded-cwd-dir'), undefined);
  assert.equal(sessionIdFromSessionFileName('notes.txt'), undefined);
  assert.equal(sessionIdFromSessionFileName(null), undefined);
});

test('external session file changes fire once after writes settle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-watcher-'));
  const dir = join(root, 'encoded-cwd');
  mkdirSync(dir);
  let calls = 0;
  const watcher = startSessionFileWatcher({
    root,
    debounceMs: 50,
    onExternalChange: () => {
      calls += 1;
    },
  });
  assert.ok(watcher);
  try {
    writeFileSync(join(dir, 'a.jsonl'), '{}\n');
    writeFileSync(join(dir, 'b.jsonl'), '{}\n');
    writeFileSync(join(dir, 'c.jsonl'), '{}\n');
    await waitFor(() => calls === 1);
    await delay(200);
    assert.equal(calls, 1, 'a burst of changes coalesces into one callback');
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes from live in-app sessions do not fire', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-watcher-'));
  const dir = join(root, 'encoded-cwd');
  mkdirSync(dir);
  let calls = 0;
  const watcher = startSessionFileWatcher({
    root,
    debounceMs: 50,
    isLiveSession: (id) => id === 'live-1',
    onExternalChange: () => {
      calls += 1;
    },
  });
  assert.ok(watcher);
  try {
    writeFileSync(join(dir, 'live-1.jsonl'), '{}\n');
    await delay(400);
    assert.equal(calls, 0, 'live session writes are pushed by the registry instead');
    writeFileSync(join(dir, 'external-1.jsonl'), '{}\n');
    await waitFor(() => calls === 1);
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('close stops further callbacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-watcher-'));
  const dir = join(root, 'encoded-cwd');
  mkdirSync(dir);
  let calls = 0;
  const watcher = startSessionFileWatcher({
    root,
    debounceMs: 50,
    onExternalChange: () => {
      calls += 1;
    },
  });
  assert.ok(watcher);
  try {
    writeFileSync(join(dir, 'a.jsonl'), '{}\n');
    await waitFor(() => calls === 1);
    watcher.close();
    writeFileSync(join(dir, 'b.jsonl'), '{}\n');
    await delay(300);
    assert.equal(calls, 1);
  } finally {
    watcher.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('returns null when the sessions root cannot be watched', () => {
  const watcher = startSessionFileWatcher({
    root: join(tmpdir(), 'droidex-definitely-missing-sessions-root'),
    onExternalChange: () => {},
  });
  assert.equal(watcher, null);
});
