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
        consumeLiveSessionFile: () => undefined,
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
      return { consumeLiveSessionFile: () => undefined, close: () => {} };
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

test('closing a live session reconciles its final file before republishing', async () => {
  const workspace = '/tmp/finalized-workspace';
  let finalizedSessionFile: string | undefined;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: () => ({
      consumeLiveSessionFile: () => finalizedSessionFile,
      close: () => {},
    }),
  });
  try {
    await ctx.create({
      cwd: workspace,
      sessionPurpose: 'chat',
      clientRef: 'finalized-session',
      title: 'Finalized session',
      goal: 'finish',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    writeExternalSession(ctx.home, 'provider-1', workspace);
    finalizedSessionFile = join(ctx.home, '.factory', 'sessions', '2026', '08', 'provider-1.jsonl');
    await ctx.handle({ type: 'sessions.list', workspaceCwds: [workspace] });
    const reconcilesBeforeClose = ctx.history.fullReconcileCalls;
    const targetedReconcilesBeforeClose = ctx.history.targetedReconcileCalls.length;

    await ctx.handle({ type: 'session.close', appSessionId: 'provider-1' });

    assert.equal(
      ctx.history.fullReconcileCalls,
      reconcilesBeforeClose,
      'an observed live file does not trigger a full sessions-tree walk on close',
    );
    assert.deepEqual(
      ctx.history.targetedReconcileCalls.slice(targetedReconcilesBeforeClose),
      [[{ providerSessionId: 'provider-1', path: finalizedSessionFile }]],
      'close reconciles only the finalized file after the live registry entry is removed',
    );
    const list = ctx.events.filter((event) => event.type === 'sessions.list').at(-1);
    assert.ok(list?.type === 'sessions.list');
    assert.ok(
      list.sessions.some((session) => session.appSessionId === 'provider-1'),
      'the post-close list retains the newly historical session',
    );
    assert.ok(
      list.sessions.every((session) => session.cwd === workspace),
      'the post-close list preserves the renderer active workspace filter',
    );
  } finally {
    await ctx.dispose();
  }
});

test('the watcher starts once per boot, not per sessions.list command', async () => {
  let starts = 0;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: () => {
      starts += 1;
      return { consumeLiveSessionFile: () => undefined, close: () => {} };
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

test('the first sessions.list waits for the warm-cache boot reconcile to settle', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    // A nonzero cache size takes the warm path: refresh from disk in the
    // background instead of populating synchronously.
    ctx.history.sessionFileCacheSize = 2;
    writeExternalSession(ctx.home, 'boot-external-session', '/tmp/boot-workspace');

    await ctx.handle({ type: 'sessions.list' });
    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      0,
      'no list is emitted while the boot reconcile is pending',
    );

    await ctx.waitForIdle();
    const lists = ctx.events.filter((event) => event.type === 'sessions.list');
    assert.equal(lists.length, 1, 'the first list is emitted once the boot reconcile settles');
    assert.equal(ctx.history.fullReconcileCalls, 1, 'the boot reconcile ran exactly once');
    assert.ok(
      lists[0]?.sessions.some((session) => session.appSessionId === 'boot-external-session'),
      'the first list already includes sessions created while the app was away',
    );

    await ctx.handle({ type: 'sessions.list' });
    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      2,
      'lists after the boot reconcile are served immediately',
    );
  } finally {
    await ctx.dispose();
  }
});

test('sessions.list commands queued during the boot reconcile emit only the latest', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    ctx.history.sessionFileCacheSize = 2;
    writeExternalSession(ctx.home, 'queued-first-session', '/tmp/first');
    writeExternalSession(ctx.home, 'queued-second-session', '/tmp/second');
    await ctx.handle({ type: 'sessions.list', workspaceCwds: ['/tmp/first'] });
    await ctx.handle({ type: 'sessions.list', workspaceCwds: ['/tmp/second'] });
    await ctx.waitForIdle();
    const lists = ctx.events.filter((event) => event.type === 'sessions.list');
    assert.equal(lists.length, 1, 'only the latest queued request emits after the reconcile');
    assert.equal(ctx.history.fullReconcileCalls, 1);
    assert.ok(
      lists[0]?.sessions.some((session) => session.appSessionId === 'queued-second-session'),
      'the emit uses the latest request filter',
    );
    assert.equal(
      lists[0]?.sessions.some((session) => session.appSessionId === 'queued-first-session'),
      false,
      'the superseded request filter is not used',
    );
  } finally {
    await ctx.dispose();
  }
});

test('a boot reconcile failure still serves the first list and never starves later ones', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    ctx.history.sessionFileCacheSize = 2;
    ctx.history.failNextReconcile = new Error('sqlite busy');
    await ctx.handle({ type: 'sessions.list' });
    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      0,
      'the list is held while the boot reconcile is pending',
    );
    await ctx.waitForIdle();
    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      1,
      'the first list is served even though the boot reconcile failed',
    );

    await ctx.handle({ type: 'sessions.list' });
    assert.equal(
      ctx.events.filter((event) => event.type === 'sessions.list').length,
      2,
      'lists after a failed boot reconcile are served immediately, not starved',
    );
    assert.equal(ctx.history.fullReconcileCalls, 1);
  } finally {
    await ctx.dispose();
  }
});

test('a seeded cwd patch is respected before workspace filtering', async () => {
  const ctx = createSessionManagerTestContext();
  try {
    // The on-disk session belongs to workspace A...
    writeExternalSession(ctx.home, 'moved-session', '/workspace-on-disk');
    // ...but a persisted app-session patch moves it to workspace B.
    ctx.fixture.seedHistorySummaries([
      {
        appSessionId: 'moved-session',
        providerSessionId: 'moved-session',
        sessionPurpose: 'chat',
        interactionMode: 'auto',
        role: 'primary',
        title: 'Moved session',
        goal: 'Moved session',
        cwd: '/workspace-patched',
        workspaceKind: 'folder',
        autonomy: 'low',
        phase: 'paused',
        features: [],
        tokensIn: 0,
        tokensOut: 0,
        contextTokens: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    await ctx.handle({ type: 'sessions.list', workspaceCwds: ['/workspace-patched'] });
    const list = ctx.events.filter((event) => event.type === 'sessions.list').at(-1);
    assert.ok(list?.type === 'sessions.list');
    assert.ok(
      list.sessions.some((session) => session.appSessionId === 'moved-session'),
      'a session whose patched cwd matches the requested workspace is listed',
    );

    await ctx.handle({ type: 'sessions.list', workspaceCwds: ['/workspace-on-disk'] });
    const onDiskList = ctx.events.filter((event) => event.type === 'sessions.list').at(-1);
    assert.ok(onDiskList?.type === 'sessions.list');
    assert.equal(
      onDiskList.sessions.some((session) => session.appSessionId === 'moved-session'),
      false,
      'the session no longer belongs to its pre-patch workspace',
    );
  } finally {
    await ctx.dispose();
  }
});

test('a watcher event during the warm-cache boot window does not emit a stale list', async () => {
  let watcherOptions: SessionFileWatcherOptions | undefined;
  const ctx = createSessionManagerTestContext({
    startSessionFileWatcher: (options) => {
      watcherOptions = options;
      return { consumeLiveSessionFile: () => undefined, close: () => {} };
    },
  });
  try {
    ctx.history.sessionFileCacheSize = 2;
    writeExternalSession(ctx.home, 'boot-window-session', '/tmp/boot-window');
    await ctx.handle({ type: 'sessions.list', workspaceCwds: ['/tmp/boot-window'] });
    // The boot reconcile is still pending. A watcher event in this window is
    // held: emitting from the partially-reconciled cache would serve a stale
    // list, and the boot full reconcile already covers the change.
    watcherOptions!.onExternalChange(null);
    assert.equal(
      ctx.history.fullReconcileCalls,
      0,
      'a watcher reconcile is not scheduled during the boot window',
    );
    await ctx.waitForIdle();
    const lists = ctx.events.filter((event) => event.type === 'sessions.list');
    assert.equal(lists.length, 1, 'only the authoritative boot reconcile list is emitted');
    assert.equal(ctx.history.fullReconcileCalls, 1, 'only the boot full reconcile ran');
  } finally {
    await ctx.dispose();
  }
});
