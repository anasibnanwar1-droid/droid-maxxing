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
    const sessionFile = join(
      ctx.home,
      '.factory',
      'sessions',
      '2026',
      '08',
      'external-session-1.jsonl',
    );
    watcherOptions.onExternalChange([
      { providerSessionId: 'external-session-1', path: sessionFile },
    ]);

    assert.deepEqual(
      ctx.history.targetedReconcileCalls,
      [[{ providerSessionId: 'external-session-1', path: sessionFile }]],
      'a targeted change list reconciles exactly the reported file',
    );
    assert.equal(ctx.history.fullReconcileCalls, 1, 'only the boot reconcile walks the tree');

    const lists = ctx.events.filter((event) => event.type === 'sessions.list');
    assert.equal(lists.length, listsBefore + 1, 'external change republishes the list');
    const republished = lists.at(-1);
    assert.equal(republished?.type, 'sessions.list');
    assert.ok(
      republished?.sessions.some((session) => session.appSessionId === 'external-session-1'),
      'republished list includes the externally created session',
    );
  } finally {
    await ctx.dispose();
  }
  assert.equal(watcherClosed, true, 'watcher closes on shutdown');
});

test('unexplained watcher events fall back to a full reconcile before republishing', async () => {
  let watcherOptions: SessionFileWatcherOptions | undefined;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: (options) => {
      watcherOptions = options;
      return { close: () => {} };
    },
  });
  try {
    await ctx.handle({ type: 'sessions.list' });
    assert.ok(watcherOptions, 'watcher starts on the first sessions.list');
    const fullReconcilesBefore = ctx.history.fullReconcileCalls;

    watcherOptions.onExternalChange(null);

    assert.equal(
      ctx.history.fullReconcileCalls,
      fullReconcilesBefore + 1,
      'a null change list runs a full reconcile',
    );
    assert.equal(ctx.history.targetedReconcileCalls.length, 0);
  } finally {
    await ctx.dispose();
  }
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
