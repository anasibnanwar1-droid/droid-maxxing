import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { SessionFileWatcherOptions } from './sessionFileWatcher.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

// Writes a session file with no app involvement, like a Droid CLI run or a
// parallel app instance would.
function writeExternalSession(home: string, id: string, cwd: string): void {
  const dir = join(home, '.factory', 'sessions', '2026', '08');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({
      type: 'session_start',
      cwd,
      sessionTitle: 'External CLI session',
      settings: { interactionMode: 'auto' },
    })}\n`,
  );
}

test('sessions created outside the app are republished live when the watcher fires', async () => {
  let watcherOptions: SessionFileWatcherOptions | undefined;
  let watcherClosed = false;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: (options) => {
      watcherOptions = options;
      return {
        close: () => {
          watcherClosed = true;
        },
      };
    },
  });
  try {
    await ctx.handle({ type: 'sessions.list' });
    assert.ok(watcherOptions, 'watcher starts on the first sessions.list');
    const listsBefore = ctx.events.filter((event) => event.type === 'sessions.list').length;

    writeExternalSession(ctx.home, 'external-session-1', '/tmp/external-workspace');
    watcherOptions.onExternalChange();

    const lists = ctx.events.filter((event) => event.type === 'sessions.list');
    assert.equal(lists.length, listsBefore + 1, 'external change republishes the list');
    const republished = lists.at(-1);
    assert.equal(republished?.type, 'sessions.list');
    assert.ok(
      republished?.sessions.some((session) => session.appSessionId === 'external-session-1'),
      'republished list includes the externally created session from a fresh disk scan',
    );
  } finally {
    await ctx.dispose();
  }
  assert.equal(watcherClosed, true, 'watcher closes on shutdown');
});

test('the watcher starts once per boot, not per sessions.list command', async () => {
  let starts = 0;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: () => {
      starts += 1;
      return { close: () => {} };
    },
  });
  try {
    await ctx.handle({ type: 'sessions.list' });
    await ctx.handle({ type: 'sessions.list' });
    await ctx.handle({ type: 'sessions.list' });
    assert.equal(starts, 1);
  } finally {
    await ctx.dispose();
  }
});
