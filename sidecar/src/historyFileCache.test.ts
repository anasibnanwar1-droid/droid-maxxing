import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type * as Protocol from './protocol.js';
import { SessionManager } from './SessionManager.js';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-history-cache-home-'));
process.env.HOME = home;

const { HistoryIndex, loadHistoricalSessions, SESSION_INDEX_FILENAME } =
  await import('./history.js');

type SessionListEvent = Extract<Protocol.ServerEvent, { type: 'sessions.list' }>;

function isSessionList(event: Protocol.ServerEvent): event is SessionListEvent {
  return event.type === 'sessions.list';
}

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function writeSession(
  root: string,
  id: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): string {
  const dir = join(root, '.factory', 'sessions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'session_start',
      cwd,
      sessionTitle: `Chat ${id}`,
      settings: { interactionMode: 'auto' },
      ...extra,
    })}\n`,
  );
  return path;
}

function patchFor(appSessionId: string, cwd: string): Protocol.SessionSummary {
  const now = Date.now();
  return {
    appSessionId,
    providerSessionId: appSessionId,
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: `Chat ${appSessionId}`,
    goal: `Chat ${appSessionId}`,
    cwd,
    workspaceKind: cwd ? 'folder' : 'none',
    autonomy: 'low',
    phase: 'paused',
    streaming: false,
    queuedSends: 0,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
  };
}

test('reconcile populates the cache and the cached list matches the uncached scan', () => {
  writeSession(home, 'cache-plain', '');
  const workspace = join(home, 'workspace-a');
  writeSession(home, 'cache-workspace', workspace);
  writeSession(home, 'cache-child', workspace, {
    callingSessionId: 'cache-workspace',
    callingToolUseId: 'tool-1',
  });

  const index = new HistoryIndex();
  try {
    assert.equal(index.reconcileSessionFiles(), 3);
    // The Task child is cached as a known non-top-level file, not re-read later.
    assert.equal(index.sessionFileCacheSize, 3);

    const cached = index.listHistoricalSessions();
    const uncached = loadHistoricalSessions();
    for (const id of ['cache-plain', 'cache-workspace']) {
      const cachedRow = cached.find((row) => row.summary.appSessionId === id);
      const uncachedRow = uncached.find((row) => row.summary.appSessionId === id);
      assert.ok(cachedRow, `cached list contains ${id}`);
      assert.ok(uncachedRow, `uncached scan contains ${id}`);
      assert.equal(cachedRow.summary.title, uncachedRow.summary.title);
      assert.equal(cachedRow.summary.cwd, uncachedRow.summary.cwd);
      assert.equal(cachedRow.summary.createdAt, uncachedRow.summary.createdAt);
      assert.equal(cachedRow.summary.updatedAt, uncachedRow.summary.updatedAt);
    }
    assert.equal(
      cached.some((row) => row.summary.appSessionId === 'cache-child'),
      false,
    );
  } finally {
    index.close();
  }
});

test('a second boot with unchanged files reconciles nothing', () => {
  const index = new HistoryIndex();
  try {
    assert.equal(index.sessionFileCacheSize, 3);
    assert.equal(index.reconcileSessionFiles(), 0);
  } finally {
    index.close();
  }
});

test('rewriting a session file refreshes its cached summary', () => {
  const workspace = join(home, 'workspace-a');
  const path = writeSession(home, 'cache-workspace', workspace, {
    sessionTitle: 'Renamed chat',
  });
  // Force a distinct mtime so the change does not depend on clock granularity.
  const later = new Date(Date.now() + 10_000);
  utimesSync(path, later, later);

  const index = new HistoryIndex();
  try {
    assert.equal(index.reconcileSessionFiles(), 1);
    const rows = index.listHistoricalSessions();
    const row = rows.find((item) => item.summary.appSessionId === 'cache-workspace');
    assert.equal(row?.summary.title, 'Renamed chat');
  } finally {
    index.close();
  }
});

test('deleting a session file removes it from the cached list', () => {
  unlinkSync(join(home, '.factory', 'sessions', 'cache-plain.jsonl'));

  const index = new HistoryIndex();
  try {
    assert.equal(index.reconcileSessionFiles(), 1);
    assert.equal(index.sessionFileCacheSize, 2);
    const rows = index.listHistoricalSessions();
    assert.equal(
      rows.some((row) => row.summary.appSessionId === 'cache-plain'),
      false,
    );
  } finally {
    index.close();
  }
});

test('cached list applies app summary patches before filtering', () => {
  const workspace = join(home, 'workspace-patch');
  writeSession(home, 'cache-patched', workspace);

  const index = new HistoryIndex();
  try {
    index.reconcileSessionFiles();
    index.syncSummaries([patchFor('cache-patched', '')]);

    const plain = index.listHistoricalSessions({ includePlainChats: true });
    const plainRow = plain.find((row) => row.summary.appSessionId === 'cache-patched');
    assert.ok(plainRow);
    assert.equal(plainRow.summary.cwd, '');
    assert.equal(plainRow.summary.workspaceKind, 'none');

    const scoped = index.listHistoricalSessions({ workspaceCwds: [workspace] });
    assert.equal(
      scoped.some((row) => row.summary.appSessionId === 'cache-patched'),
      false,
    );
  } finally {
    index.close();
  }
});

test('a corrupt cache row is dropped and rebuilt on the next boot', () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'droid-history-cache-corrupt-'));
  const previousHome = process.env.HOME;
  process.env.HOME = freshHome;
  try {
    writeSession(freshHome, 'corrupt-row', join(freshHome, 'workspace'));
    const dbPath = join(freshHome, '.factory', 'droidex', SESSION_INDEX_FILENAME);

    const first = new HistoryIndex();
    try {
      assert.equal(first.reconcileSessionFiles(), 1);
      assert.equal(first.sessionFileCacheSize, 1);
    } finally {
      first.close();
    }

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        'UPDATE session_file_cache SET summary_json = ? WHERE provider_session_id = ?',
      ).run('{not json', 'corrupt-row');
    } finally {
      db.close();
    }

    const second = new HistoryIndex();
    try {
      // The corrupt row is dropped at load, so the next reconcile rebuilds it.
      assert.equal(second.sessionFileCacheSize, 0);
      assert.equal(second.reconcileSessionFiles(), 1);
      const rows = second.listHistoricalSessions();
      assert.ok(rows.some((row) => row.summary.appSessionId === 'corrupt-row'));
    } finally {
      second.close();
    }
  } finally {
    process.env.HOME = previousHome;
    rmSync(freshHome, { recursive: true, force: true });
  }
});

test('a settings sidecar change refreshes the cached summary', () => {
  const workspace = join(home, 'workspace-settings');
  writeSession(home, 'cache-settings', workspace);

  const first = new HistoryIndex();
  try {
    first.reconcileSessionFiles();
    const before = first
      .listHistoricalSessions()
      .find((row) => row.summary.appSessionId === 'cache-settings');
    assert.equal(before?.summary.modelId, undefined);
  } finally {
    first.close();
  }

  // The session file is untouched; only its settings sidecar appears.
  writeFileSync(
    join(home, '.factory', 'sessions', 'cache-settings.settings.json'),
    JSON.stringify({ modelId: 'cached-settings-model' }),
  );

  const second = new HistoryIndex();
  try {
    assert.equal(
      second.reconcileSessionFiles(),
      1,
      'settings mtime drift re-summarizes the session',
    );
    const after = second
      .listHistoricalSessions()
      .find((row) => row.summary.appSessionId === 'cache-settings');
    assert.equal(after?.summary.modelId, 'cached-settings-model');
  } finally {
    second.close();
  }
});

test('reconcileSessionFilePaths touches exactly the reported files', () => {
  const workspace = join(home, 'workspace-targeted');
  const keepPath = writeSession(home, 'cache-target-keep', workspace);
  const changePath = writeSession(home, 'cache-target-change', workspace);

  const first = new HistoryIndex();
  try {
    first.reconcileSessionFiles();
  } finally {
    first.close();
  }

  writeSession(home, 'cache-target-change', workspace, { sessionTitle: 'Targeted rename' });
  // Force a distinct mtime so the change does not depend on clock granularity.
  const later = new Date(Date.now() + 30_000);
  utimesSync(changePath, later, later);

  const second = new HistoryIndex();
  try {
    // An unchanged reported file costs only a stat.
    assert.equal(
      second.reconcileSessionFilePaths([
        { providerSessionId: 'cache-target-keep', path: keepPath },
      ]),
      0,
    );
    assert.equal(
      second.reconcileSessionFilePaths([
        { providerSessionId: 'cache-target-change', path: changePath },
      ]),
      1,
    );
    const renamed = second
      .listHistoricalSessions()
      .find((row) => row.summary.appSessionId === 'cache-target-change');
    assert.equal(renamed?.summary.title, 'Targeted rename');

    // A reported file that no longer exists is dropped from the cache.
    unlinkSync(changePath);
    assert.equal(
      second.reconcileSessionFilePaths([
        { providerSessionId: 'cache-target-change', path: changePath },
      ]),
      1,
    );
    assert.equal(
      second
        .listHistoricalSessions()
        .some((row) => row.summary.appSessionId === 'cache-target-change'),
      false,
    );
  } finally {
    second.close();
  }
});

test('first sessions.list on an empty cache scans synchronously and serves rows', async () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'droid-history-cache-boot-'));
  const previousHome = process.env.HOME;
  process.env.HOME = freshHome;
  try {
    writeSession(freshHome, 'boot-session', join(freshHome, 'workspace'));
    const events: Protocol.ServerEvent[] = [];
    const manager = new SessionManager((event) => events.push(event));
    try {
      await manager.handle({ type: 'sessions.list' });
      const list = events.filter(isSessionList).at(-1);
      assert.ok(list);
      assert.ok(list.sessions.some((session) => session.appSessionId === 'boot-session'));
    } finally {
      await manager.shutdown();
    }
  } finally {
    process.env.HOME = previousHome;
    rmSync(freshHome, { recursive: true, force: true });
  }
});

test('a warm cache is served first and a background reconcile republishes changes', async () => {
  const freshHome = mkdtempSync(join(tmpdir(), 'droid-history-cache-warm-'));
  const previousHome = process.env.HOME;
  process.env.HOME = freshHome;
  try {
    const path = writeSession(freshHome, 'warm-session', join(freshHome, 'workspace'));
    const firstBootEvents: Protocol.ServerEvent[] = [];
    const firstBoot = new SessionManager((event) => firstBootEvents.push(event));
    try {
      await firstBoot.handle({ type: 'sessions.list' });
    } finally {
      await firstBoot.shutdown();
    }

    // The file changes while the app is closed.
    writeSession(freshHome, 'warm-session', join(freshHome, 'workspace'), {
      sessionTitle: 'Edited elsewhere',
    });
    const later = new Date(Date.now() + 10_000);
    utimesSync(path, later, later);

    const events: Protocol.ServerEvent[] = [];
    const manager = new SessionManager((event) => events.push(event));
    try {
      await manager.handle({ type: 'sessions.list' });
      const first = events.filter(isSessionList).at(-1);
      assert.ok(first);
      // The stale cached row is served immediately.
      assert.equal(
        first.sessions.find((session) => session.appSessionId === 'warm-session')?.title,
        'Chat warm-session',
      );

      // The background reconcile republishes the list with the changed row.
      let republished: SessionListEvent | undefined;
      for (let i = 0; i < 10 && !republished; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        const list = events.filter(isSessionList).at(-1);
        if (list && list !== first) republished = list;
      }
      assert.ok(republished);
      assert.equal(
        republished.sessions.find((session) => session.appSessionId === 'warm-session')?.title,
        'Edited elsewhere',
      );
    } finally {
      await manager.shutdown();
    }
  } finally {
    process.env.HOME = previousHome;
    rmSync(freshHome, { recursive: true, force: true });
  }
});
