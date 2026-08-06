import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-history-session-scan-home-'));
process.env.HOME = home;

const { loadHistoricalSessions } = await import('./history.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

let seq = 0;
function writeSession(id: string, title: string): void {
  const dir = join(home, '.factory', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({
      type: 'session_start',
      cwd: '',
      sessionTitle: title,
      settings: { interactionMode: 'auto' },
    })}\n`,
  );
}

function titles(): string[] {
  return loadHistoricalSessions()
    .map((row) => row.summary.title)
    .sort();
}

// These tests pin the uncached scan's freshness contract: it backs the
// session file cache reconcile, so a change written between two scans must
// show up in the second one.

test('a session file rewritten between scans serves its new summary', () => {
  seq += 1;
  const id = `scan-rewrite-${seq}`;
  writeSession(id, 'before the rewrite');
  assert.ok(titles().includes('before the rewrite'));

  writeSession(id, 'after the rewrite — changed on disk');
  const after = titles();
  assert.ok(after.includes('after the rewrite — changed on disk'));
  assert.ok(!after.includes('before the rewrite'));
});

test('a settings sidecar written between scans invalidates the summary', () => {
  seq += 1;
  const id = `scan-settings-${seq}`;
  writeSession(id, `settings session ${seq}`);
  const before = loadHistoricalSessions().find((row) => row.summary.appSessionId === id);
  assert.equal(before?.summary.modelId, undefined);

  writeFileSync(
    join(home, '.factory', 'sessions', `${id}.settings.json`),
    JSON.stringify({ modelId: 'scan-test-model' }),
  );
  const after = loadHistoricalSessions().find((row) => row.summary.appSessionId === id);
  assert.equal(after?.summary.modelId, 'scan-test-model');
});

test('a session file created between scans appears, and a deleted one disappears', () => {
  seq += 1;
  const id = `scan-create-${seq}`;
  writeSession(id, `created late ${seq}`);
  assert.ok(titles().includes(`created late ${seq}`));

  unlinkSync(join(home, '.factory', 'sessions', `${id}.jsonl`));
  assert.ok(!titles().includes(`created late ${seq}`));
});
