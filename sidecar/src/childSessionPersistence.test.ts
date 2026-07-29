import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PersistedChildSession } from './history.js';

const originalHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), 'droid-child-session-persistence-'));
process.env.HOME = home;

const { HistoryIndex } = await import('./history.js');

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function child(
  parentAppSessionId: string,
  childSessionId: string,
  overrides: Partial<PersistedChildSession> = {},
): PersistedChildSession {
  return {
    parentAppSessionId,
    childSessionId,
    providerSessionId: `provider-${parentAppSessionId}-${childSessionId}`,
    role: 'worker',
    label: 'Worker',
    prompt: `Prompt for ${childSessionId}`,
    status: 'running',
    modelId: 'claude-sonnet-4-5',
    reasoningEffort: 'high',
    spawnLink: { kind: 'tool-use', id: `tool-${childSessionId}` },
    transcriptAvailable: true,
    startedAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

test('child persistence preserves exact identity, settings, role, and hierarchy across reopen', () => {
  const index = new HistoryIndex();
  index.upsertChildSession(child('parent-a', 'child-a', { label: 'Same-role worker' }));
  index.upsertChildSession(child('parent-a', 'child-b', { label: 'Same-role worker' }));
  index.upsertChildSession(
    child('parent-b', 'child-a', {
      role: 'validator',
      label: 'Validator',
      modelId: 'claude-opus-4-1',
      reasoningEffort: 'max',
      spawnLink: { kind: 'spawn', id: 'spawn-validator' },
      transcriptAvailable: false,
      status: 'pending',
    }),
  );
  index.close();

  const reopened = new HistoryIndex();
  const parentA = reopened.childSessions('parent-a');
  const parentBChild = reopened.childSession('parent-b', 'child-a');
  reopened.close();

  assert.deepEqual(
    parentA.map(({ childSessionId, role, label }) => ({ childSessionId, role, label })),
    [
      { childSessionId: 'child-a', role: 'worker', label: 'Same-role worker' },
      { childSessionId: 'child-b', role: 'worker', label: 'Same-role worker' },
    ],
  );
  assert.deepEqual(parentBChild, {
    parentAppSessionId: 'parent-b',
    childSessionId: 'child-a',
    providerSessionId: 'provider-parent-b-child-a',
    role: 'validator',
    label: 'Validator',
    prompt: 'Prompt for child-a',
    status: 'pending',
    modelId: 'claude-opus-4-1',
    reasoningEffort: 'max',
    spawnLink: { kind: 'spawn', id: 'spawn-validator' },
    transcriptAvailable: false,
    startedAt: 100,
    updatedAt: 200,
  });
});

test('provider replacement updates runtime identity without changing logical child identity', () => {
  const index = new HistoryIndex();
  const original = child('parent-rekey', 'stable-child', {
    providerSessionId: 'provider-old',
    status: 'paused',
  });
  index.upsertChildSession(original);
  index.upsertChildSession({
    ...original,
    providerSessionId: 'provider-new',
    status: 'running',
    updatedAt: 300,
  });

  const restored = index.childSessions('parent-rekey');
  index.close();

  assert.equal(restored.length, 1);
  assert.equal(restored[0].childSessionId, 'stable-child');
  assert.equal(restored[0].providerSessionId, 'provider-new');
  assert.equal(restored[0].status, 'running');
});

test('canonical indexes reject duplicate provider and spawn ownership within one parent', () => {
  const index = new HistoryIndex();
  index.upsertChildSession(
    child('identity-parent', 'child-one', {
      providerSessionId: 'shared-provider',
      spawnLink: { kind: 'tool-use', id: 'spawn-one' },
    }),
  );

  assert.throws(
    () =>
      index.upsertChildSession(
        child('identity-parent', 'child-two', {
          providerSessionId: 'shared-provider',
          spawnLink: { kind: 'tool-use', id: 'spawn-two' },
        }),
      ),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () =>
      index.upsertChildSession(
        child('identity-parent', 'child-three', {
          providerSessionId: 'other-provider',
          spawnLink: { kind: 'tool-use', id: 'spawn-one' },
        }),
      ),
    /UNIQUE constraint failed/,
  );
  assert.doesNotThrow(() =>
    index.upsertChildSession(
      child('other-parent', 'child-one', {
        providerSessionId: 'shared-provider',
        spawnLink: { kind: 'tool-use', id: 'spawn-one' },
      }),
    ),
  );
  index.close();
});

test('fresh history index uses only the canonical child schema', () => {
  const index = new HistoryIndex();
  index.close();
  const db = new DatabaseSync(join(home, '.factory', 'droid-control', 'index.sqlite'));

  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const tables = (
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map(({ name }) => name);
  const childColumns = (
    db.prepare('PRAGMA table_info(child_sessions)').all() as { name: string }[]
  ).map(({ name }) => name);
  db.close();

  assert.equal(version.user_version, 1);
  assert.ok(tables.includes('child_sessions'));
  assert.ok(!tables.includes('child_session_links'));
  assert.ok(!tables.includes('linked_child_sessions'));
  assert.deepEqual(childColumns, [
    'parent_app_session_id',
    'child_session_id',
    'provider_session_id',
    'role',
    'label',
    'prompt',
    'status',
    'model_id',
    'reasoning_effort',
    'spawn_link_kind',
    'spawn_link_id',
    'transcript_available',
    'started_at',
    'updated_at',
  ]);
});

test('version-one index missing a canonical identity constraint uses hard-cut recovery', () => {
  const malformedHome = mkdtempSync(join(tmpdir(), 'droid-child-schema-v1-malformed-'));
  process.env.HOME = malformedHome;
  try {
    const index = new HistoryIndex();
    index.close();
    const indexPath = join(malformedHome, '.factory', 'droid-control', 'index.sqlite');
    const db = new DatabaseSync(indexPath);
    db.exec('DROP INDEX child_sessions_provider_identity;');
    db.close();

    assert.throws(
      () => new HistoryIndex(),
      /remove ~\/\.factory\/droid-control\/index\.sqlite.*Raw Factory session history is not removed\./,
    );
  } finally {
    process.env.HOME = home;
    rmSync(malformedHome, { recursive: true, force: true });
  }
});

test('incompatible local index fails fast with explicit recovery and leaves raw history intact', () => {
  const incompatibleHome = mkdtempSync(join(tmpdir(), 'droid-child-schema-recovery-'));
  const indexDir = join(incompatibleHome, '.factory', 'droid-control');
  const rawDir = join(incompatibleHome, '.factory', 'sessions', '2026', '07');
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  const rawPath = join(rawDir, 'raw-session.jsonl');
  const raw = '{"type":"session_start","id":"raw-session"}\n';
  writeFileSync(rawPath, raw);
  const incompatiblePath = join(indexDir, 'index.sqlite');
  const db = new DatabaseSync(incompatiblePath);
  db.exec('CREATE TABLE child_session_links (app_session_id TEXT, provider_session_id TEXT);');
  db.close();

  process.env.HOME = incompatibleHome;
  try {
    assert.throws(
      () => new HistoryIndex(),
      /remove ~\/\.factory\/droid-control\/index\.sqlite.*Raw Factory session history is not removed\./,
    );
    assert.equal(readFileSync(rawPath, 'utf8'), raw);
    const reopened = new DatabaseSync(incompatiblePath);
    const legacyTable = reopened
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'child_session_links'",
      )
      .get();
    const canonicalTable = reopened
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'child_sessions'")
      .get();
    reopened.close();
    assert.ok(legacyTable);
    assert.equal(canonicalTable, undefined);
  } finally {
    process.env.HOME = home;
    rmSync(incompatibleHome, { recursive: true, force: true });
  }
});
