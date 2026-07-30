import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { numberValue, stringValue } from './values.js';
import type {
  SessionRole,
  Autonomy,
  BridgeFeature,
  FeatureStatus,
  FactoryDefaultSettings,
  SessionHistoryEntry,
  SessionPhase,
  SessionSummary,
  ProgressEntry,
  ReasoningEffort,
  TranscriptEvent,
} from './protocol.js';
import { mapFeature } from './normalize.js';
import { designPromptDisplayFromText } from './browser/designPromptDisplay.js';
import { normalizeCompactionTokenLimit } from './compaction.js';

interface StoredMissionState {
  missionId?: string;
  baseSessionId?: string;
  state?: string;
  workingDirectory?: string;
  cwd?: string;
  workerSessionIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface StoredFeatureFile {
  features?: unknown[];
}

interface StoredMessageLine {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown[];
  };
}

interface StoredSessionStart {
  type?: string;
  id?: string;
  cwd?: string;
  title?: string;
  sessionTitle?: string;
  decompSessionType?: string;
  decompMissionId?: string;
  // Present when this session was spawned by another session's tool call
  // (Factory Task tool children). Such sessions are not standalone conversations.
  callingSessionId?: string;
  callingToolUseId?: string;
}

interface StoredModelSettings {
  model?: string;
  modelId?: string;
  reasoningEffort?: string;
  compactionModel?: string;
  compactionTokenLimit?: number;
  compactionTokenLimitPerModel?: Record<string, number>;
  autonomyLevel?: string;
  workerModel?: string;
  workerReasoningEffort?: string;
  validationWorkerModel?: string;
  validationWorkerReasoningEffort?: string;
}

export interface HistoricalSession {
  summary: SessionSummary;
  progress: ProgressEntry[];
}

interface StoredProgressEntry extends ProgressEntry {
  workerProviderSessionId?: string;
  spawnId?: string;
}

export interface HistoricalSummaryFilter {
  workspaceCwds?: string[];
  includePlainChats?: boolean;
  limitPerWorkspace?: number;
}

export interface HydratedSessionHistory {
  progress: ProgressEntry[];
  transcripts: TranscriptEvent[];
  // Opaque cursor for the next (older) page of orchestrator scrollback across
  // the compaction chain; undefined once the oldest segment has been loaded.
  olderCursor?: string;
}

export type FactoryDefaults = FactoryDefaultSettings;

export interface HistoryPage {
  events: TranscriptEvent[];
  nextCursor?: string;
}

export type PersistedChildRole = 'worker' | 'validator';
export type PersistedChildStatus = 'pending' | 'running' | 'paused' | 'completed';

export interface PersistedChildSpawnLink {
  kind: 'tool-use' | 'spawn';
  id: string;
}

export interface PersistedChildSession {
  parentAppSessionId: string;
  childSessionId: string;
  providerSessionId?: string;
  role: PersistedChildRole;
  label?: string;
  prompt?: string;
  status: PersistedChildStatus;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  spawnLink?: PersistedChildSpawnLink;
  transcriptAvailable: boolean;
  startedAt?: number;
  updatedAt: number;
}

const STATE_TO_PHASE: Record<string, SessionPhase> = {
  initializing: 'initializing',
  running: 'running',
  paused: 'paused',
  orchestrator_turn: 'orchestrator_turn',
  completed: 'completed',
  failed: 'failed',
  awaiting_input: 'running',
};

const MAX_TEXT_CHARS = 12_000;
// Safety cap for worker transcript events on the initial page (the orchestrator
// scrollback is paged via the cursor, so only workers need bounding here).
// How many orchestrator scrollback events to load per page (initial open and
// each lazy older-page fetch). Bounds work for very long, multi-compaction chats.
const DEFAULT_HISTORY_WINDOW = 400;
// Per-segment span used to derive a global monotonic `seq` from a chain index +
// in-segment position. Must exceed any single segment's windowed item count;
// oversized files are tail-windowed at SESSION_*_BYTES, far below this.
const SEQ_SEGMENT_STRIDE = 1_000_000;
const MAX_SESSION_BYTES = 5_000_000;
const SESSION_START_BYTES = 256_000;
const HISTORY_SCHEMA_VERSION = 1;
export const SESSION_INDEX_FILENAME = 'session-index.sqlite';
const HISTORY_SCHEMA_RECOVERY =
  'DROIDEX local history index uses an incompatible schema. Quit DROIDEX, remove ' +
  `~/.factory/droid-control/${SESSION_INDEX_FILENAME}, ` +
  `~/.factory/droid-control/${SESSION_INDEX_FILENAME}-wal, and ` +
  `~/.factory/droid-control/${SESSION_INDEX_FILENAME}-shm, then restart. ` +
  'Raw Factory session history is not removed.';

export function loadMissionControlSessions(
  options: HistoricalSummaryFilter = {},
): HistoricalSession[] {
  const workspaceCwds = options.workspaceCwds
    ? new Set(options.workspaceCwds.filter(Boolean))
    : null;
  if (workspaceCwds && workspaceCwds.size === 0 && !options.includePlainChats) return [];
  const rows = missionDirs()
    .filter((dir) => {
      if (!workspaceCwds && !options.includePlainChats) return true;
      const state = readJson<StoredMissionState>(join(dir, 'state.json'));
      return shouldIncludeCwd(
        state.workingDirectory || state.cwd || '',
        workspaceCwds,
        options.includePlainChats,
      );
    })
    .map((dir) => loadMissionControlSession(dir))
    .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt);
  return limitHistoricalRows(
    rows,
    workspaceCwds,
    options.limitPerWorkspace,
    options.includePlainChats,
  );
}

export function loadHistoricalSessions(options: HistoricalSummaryFilter = {}): HistoricalSession[] {
  const rows: HistoricalSession[] = [];
  const cached = readStoredSummaryPatches();
  const workspaceCwds = options.workspaceCwds
    ? new Set(options.workspaceCwds.filter(Boolean))
    : null;
  if (workspaceCwds && workspaceCwds.size === 0 && !options.includePlainChats) return [];
  for (const [providerSessionId, path] of buildSessionIndex()) {
    const start = readSessionStart(path);
    const classification = classifyStoredSession(start);
    if (!classification) continue;
    const stat = statSync(path);
    const title = start.sessionTitle || start.title || `Session ${providerSessionId.slice(0, 8)}`;
    const settings = readSessionModelSettings(start, path);
    const summary = applyCachedSummary(
      {
        appSessionId: providerSessionId,
        providerSessionId,
        missionId: classification.missionId,
        sessionPurpose: classification.sessionPurpose,
        interactionMode: classification.interactionMode,
        role: classification.role,
        title,
        goal: title,
        cwd: start.cwd ?? '',
        workspaceKind: start.cwd ? 'folder' : 'none',
        ...settings,
        autonomy: settings.autonomy ?? 'low',
        phase: 'paused',
        streaming: false,
        queuedSends: 0,
        features: [],
        tokensIn: 0,
        tokensOut: 0,
        contextTokens: 0,
        createdAt: stat.birthtimeMs,
        updatedAt: stat.mtimeMs,
      },
      cached,
    );
    if (
      (workspaceCwds || options.includePlainChats) &&
      !shouldIncludeCwd(summary.cwd ?? '', workspaceCwds, options.includePlainChats)
    )
      continue;
    rows.push({
      summary,
      progress: [],
    });
  }
  return limitHistoricalRows(
    rows.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt),
    workspaceCwds,
    options.limitPerWorkspace,
    options.includePlainChats,
  );
}

export function loadSessionHistory(): SessionHistoryEntry[] {
  const rows: SessionHistoryEntry[] = [];
  for (const [providerSessionId, path] of buildSessionIndex()) {
    const start = readSessionStart(path);
    const stat = statSync(path);
    rows.push({
      providerSessionId,
      title: start.sessionTitle || start.title || `Session ${providerSessionId.slice(0, 8)}`,
      cwd: start.cwd,
      modifiedTime: stat.mtimeMs,
      createdTime: stat.birthtimeMs,
      messageCount: countSessionMessages(path),
    });
  }
  return rows.sort((a, b) => b.modifiedTime - a.modifiedTime);
}

export function loadSessionPage(
  providerSessionId: string,
  appSessionId: string,
  cursor?: string,
  limit = 200,
): HistoryPage {
  const path = buildSessionIndex().get(providerSessionId);
  if (!path) throw new Error(`Session history not found for ${providerSessionId}`);
  const role = roleFromSessionStart(readSessionStart(path));
  const all = parseSessionTranscript(appSessionId, providerSessionId, path, role);
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const end = cursor ? Math.max(0, Number(cursor) || 0) : all.length;
  const start = Math.max(0, end - safeLimit);
  return {
    events: all.slice(start, end),
    nextCursor: start > 0 ? String(start) : undefined,
  };
}

export class HistoryIndex {
  private db: DatabaseSync;

  constructor() {
    const dir = join(homedir(), '.factory', 'droid-control');
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, SESSION_INDEX_FILENAME));
    try {
      HistoryIndex.initializeOrValidateHistorySchema(db);
      db.exec('PRAGMA journal_mode = WAL');
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private static initializeOrValidateHistorySchema(db: DatabaseSync): void {
    const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
    const version = numberValue(row?.user_version) ?? 0;
    const nonEmpty =
      db
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
        )
        .get() !== undefined;
    if (!nonEmpty) {
      HistoryIndex.createSchema(db);
      return;
    }
    if (version !== HISTORY_SCHEMA_VERSION || !hasCanonicalChildSchema(db))
      throw new Error(HISTORY_SCHEMA_RECOVERY);
  }

  private static createSchema(db: DatabaseSync): void {
    db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS app_sessions (
        app_session_id TEXT PRIMARY KEY,
        provider_session_id TEXT NOT NULL,
        compacted_from_provider_session_ids TEXT NOT NULL DEFAULT '[]',
        session_purpose TEXT NOT NULL,
        interaction_mode TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT,
        workspace_kind TEXT,
        updated_at INTEGER NOT NULL,
        model_id TEXT,
        reasoning_effort TEXT,
        compaction_model TEXT,
        worker_model_id TEXT,
        worker_reasoning_effort TEXT,
        validator_model_id TEXT,
        validator_reasoning_effort TEXT,
        autonomy TEXT,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        context_tokens INTEGER NOT NULL DEFAULT 0,
        context_remaining_tokens INTEGER,
        context_accuracy TEXT,
        context_updated_at TEXT,
        max_context_tokens INTEGER,
        auto_compactions INTEGER
      );
      CREATE TABLE IF NOT EXISTS child_sessions (
        parent_app_session_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL,
        provider_session_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('worker', 'validator')),
        label TEXT,
        prompt TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed')),
        model_id TEXT NOT NULL,
        reasoning_effort TEXT,
        spawn_link_kind TEXT CHECK (spawn_link_kind IN ('tool-use', 'spawn')),
        spawn_link_id TEXT,
        transcript_available INTEGER NOT NULL CHECK (transcript_available IN (0, 1)),
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        CHECK (
          (spawn_link_kind IS NULL AND spawn_link_id IS NULL) OR
          (spawn_link_kind IS NOT NULL AND spawn_link_id IS NOT NULL)
        ),
        PRIMARY KEY (parent_app_session_id, child_session_id)
      );
      CREATE UNIQUE INDEX child_sessions_provider_identity
        ON child_sessions (parent_app_session_id, provider_session_id)
        WHERE provider_session_id IS NOT NULL;
      CREATE UNIQUE INDEX child_sessions_spawn_identity
        ON child_sessions (parent_app_session_id, spawn_link_kind, spawn_link_id)
        WHERE spawn_link_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        app_session_id TEXT,
        kind TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS features (
        mission_id TEXT NOT NULL,
        feature_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (mission_id, feature_id)
      );
      CREATE TABLE IF NOT EXISTS progress (
        mission_id TEXT NOT NULL,
        key TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (mission_id, key)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        request_id TEXT PRIMARY KEY,
        app_session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        request_id TEXT PRIMARY KEY,
        app_session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        scope TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_cache (
        catalog TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = ${String(HISTORY_SCHEMA_VERSION)};
      COMMIT;
    `);
  }

  syncSummaries(summaries: SessionSummary[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO app_sessions (
        app_session_id,
        provider_session_id,
        compacted_from_provider_session_ids,
        session_purpose,
        interaction_mode,
        title,
        cwd,
        workspace_kind,
        updated_at,
        model_id,
        reasoning_effort,
        compaction_model,
        worker_model_id,
        worker_reasoning_effort,
        validator_model_id,
        validator_reasoning_effort,
        autonomy,
        tokens_in,
        tokens_out,
        context_tokens,
        context_remaining_tokens,
        context_accuracy,
        context_updated_at,
        max_context_tokens,
        auto_compactions
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_session_id) DO UPDATE SET
        provider_session_id = excluded.provider_session_id,
        compacted_from_provider_session_ids = excluded.compacted_from_provider_session_ids,
        session_purpose = excluded.session_purpose,
        interaction_mode = excluded.interaction_mode,
        title = excluded.title,
        cwd = excluded.cwd,
        workspace_kind = excluded.workspace_kind,
        updated_at = excluded.updated_at,
        model_id = excluded.model_id,
        reasoning_effort = excluded.reasoning_effort,
        compaction_model = excluded.compaction_model,
        worker_model_id = excluded.worker_model_id,
        worker_reasoning_effort = excluded.worker_reasoning_effort,
        validator_model_id = excluded.validator_model_id,
        validator_reasoning_effort = excluded.validator_reasoning_effort,
        autonomy = excluded.autonomy,
        tokens_in = excluded.tokens_in,
        tokens_out = excluded.tokens_out,
        context_tokens = excluded.context_tokens,
        context_remaining_tokens = excluded.context_remaining_tokens,
        context_accuracy = excluded.context_accuracy,
        context_updated_at = excluded.context_updated_at,
        max_context_tokens = excluded.max_context_tokens,
        auto_compactions = excluded.auto_compactions
    `);
    for (const summary of summaries) {
      stmt.run(
        summary.appSessionId,
        summary.providerSessionId ?? summary.appSessionId,
        JSON.stringify(summary.compactedFromProviderSessionIds ?? []),
        summary.sessionPurpose,
        summary.interactionMode,
        summary.title,
        sqlValue(summary.cwd),
        sqlValue(summary.workspaceKind),
        summary.updatedAt,
        sqlValue(summary.modelId),
        sqlValue(summary.reasoningEffort),
        sqlValue(summary.compactionModel),
        sqlValue(summary.workerModelId),
        sqlValue(summary.workerReasoningEffort),
        sqlValue(summary.validatorModelId),
        sqlValue(summary.validatorReasoningEffort),
        sqlValue(summary.autonomy),
        summary.tokensIn,
        summary.tokensOut,
        summary.contextTokens,
        sqlValue(summary.contextRemainingTokens),
        sqlValue(summary.contextAccuracy),
        sqlValue(summary.contextUpdatedAt),
        sqlValue(summary.maxContextTokens),
        sqlValue(summary.autoCompactions),
      );
    }
  }

  summaryPatches(): Map<string, Partial<SessionSummary>> {
    const rows = this.db.prepare('SELECT * FROM app_sessions').all() as Record<string, unknown>[];
    return summaryPatchesFromRows(rows);
  }

  hiddenProviderSessionIds(): Set<string> {
    const rows = this.db
      .prepare('SELECT app_session_id, compacted_from_provider_session_ids FROM app_sessions')
      .all() as Record<string, unknown>[];
    const hidden = new Set<string>();
    for (const row of rows) {
      const appSessionId = stringValue(row.app_session_id);
      for (const providerSessionId of jsonStringArray(row.compacted_from_provider_session_ids)) {
        if (providerSessionId && providerSessionId !== appSessionId) hidden.add(providerSessionId);
      }
    }
    return hidden;
  }

  recordEvent(event: TranscriptEvent): void {
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO events (id, source_session_id, app_session_id, kind, ts)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(event.id, event.sourceSessionId, event.appSessionId, event.kind, event.ts);
  }

  upsertChildSession(child: PersistedChildSession): void {
    this.db
      .prepare(
        `
      INSERT INTO child_sessions (
        parent_app_session_id,
        child_session_id,
        provider_session_id,
        role,
        label,
        prompt,
        status,
        model_id,
        reasoning_effort,
        spawn_link_kind,
        spawn_link_id,
        transcript_available,
        started_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(parent_app_session_id, child_session_id) DO UPDATE SET
        provider_session_id = excluded.provider_session_id,
        role = excluded.role,
        label = excluded.label,
        prompt = excluded.prompt,
        status = excluded.status,
        model_id = excluded.model_id,
        reasoning_effort = excluded.reasoning_effort,
        spawn_link_kind = excluded.spawn_link_kind,
        spawn_link_id = excluded.spawn_link_id,
        transcript_available = excluded.transcript_available,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        child.parentAppSessionId,
        child.childSessionId,
        sqlValue(child.providerSessionId),
        child.role,
        sqlValue(child.label),
        sqlValue(child.prompt),
        child.status,
        child.modelId,
        sqlValue(child.reasoningEffort),
        sqlValue(child.spawnLink?.kind),
        sqlValue(child.spawnLink?.id),
        child.transcriptAvailable ? 1 : 0,
        sqlValue(child.startedAt),
        child.updatedAt,
      );
  }

  childSessions(parentAppSessionId: string): PersistedChildSession[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM child_sessions WHERE parent_app_session_id = ? ORDER BY updated_at ASC, child_session_id ASC',
      )
      .all(parentAppSessionId) as Record<string, unknown>[];
    return rows.map(persistedChildSessionFromRow);
  }

  childSession(
    parentAppSessionId: string,
    childSessionId: string,
  ): PersistedChildSession | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM child_sessions WHERE parent_app_session_id = ? AND child_session_id = ?',
      )
      .get(parentAppSessionId, childSessionId) as Record<string, unknown> | undefined;
    return row ? persistedChildSessionFromRow(row) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

const CANONICAL_TABLE_COLUMNS = {
  app_sessions: [
    'app_session_id',
    'provider_session_id',
    'compacted_from_provider_session_ids',
    'session_purpose',
    'interaction_mode',
    'title',
    'cwd',
    'workspace_kind',
    'updated_at',
    'model_id',
    'reasoning_effort',
    'compaction_model',
    'worker_model_id',
    'worker_reasoning_effort',
    'validator_model_id',
    'validator_reasoning_effort',
    'autonomy',
    'tokens_in',
    'tokens_out',
    'context_tokens',
    'context_remaining_tokens',
    'context_accuracy',
    'context_updated_at',
    'max_context_tokens',
    'auto_compactions',
  ],
  child_sessions: [
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
  ],
  events: ['id', 'source_session_id', 'app_session_id', 'kind', 'ts'],
  features: ['mission_id', 'feature_id', 'status', 'updated_at'],
  progress: ['mission_id', 'key', 'ts'],
  approvals: ['request_id', 'app_session_id', 'kind', 'created_at'],
  questions: ['request_id', 'app_session_id', 'created_at'],
  settings: ['scope', 'value_json', 'updated_at'],
  catalog_cache: ['catalog', 'value_json', 'updated_at'],
} as const;

const CHILD_SCHEMA_CHECKS = [
  "check (role in ('worker', 'validator'))",
  "check (status in ('pending', 'running', 'paused', 'completed'))",
  'check (transcript_available in (0, 1))',
  '(spawn_link_kind is null and spawn_link_id is null)',
  '(spawn_link_kind is not null and spawn_link_id is not null)',
] as const;

const CANONICAL_PRIMARY_KEYS = {
  app_sessions: ['app_session_id'],
  child_sessions: ['parent_app_session_id', 'child_session_id'],
  events: ['id'],
  features: ['mission_id', 'feature_id'],
  progress: ['mission_id', 'key'],
  approvals: ['request_id'],
  questions: ['request_id'],
  settings: ['scope'],
  catalog_cache: ['catalog'],
} as const;

function hasCanonicalChildSchema(db: DatabaseSync): boolean {
  for (const [table, expected] of Object.entries(CANONICAL_TABLE_COLUMNS)) {
    if (
      !hasExactColumns(db, table, expected) ||
      !hasPrimaryKey(
        db,
        table,
        CANONICAL_PRIMARY_KEYS[table as keyof typeof CANONICAL_PRIMARY_KEYS],
      )
    )
      return false;
  }
  return (
    hasPartialUniqueIndex(
      db,
      'child_sessions_provider_identity',
      ['parent_app_session_id', 'provider_session_id'],
      'provider_session_id is not null',
    ) &&
    hasPartialUniqueIndex(
      db,
      'child_sessions_spawn_identity',
      ['parent_app_session_id', 'spawn_link_kind', 'spawn_link_id'],
      'spawn_link_id is not null',
    ) &&
    childSchemaHasChecks(db)
  );
}

function hasExactColumns(db: DatabaseSync, table: string, expected: readonly string[]): boolean {
  const columns = tableInfo(db, table)
    .map((row) => stringValue(row.name))
    .filter((name) => name !== undefined);
  return columns.length === expected.length && expected.every((column) => columns.includes(column));
}

function hasPrimaryKey(
  db: DatabaseSync,
  table: string,
  expectedColumns: readonly string[],
): boolean {
  const columns = tableInfo(db, table)
    .filter((row) => (numberValue(row.pk) ?? 0) > 0)
    .sort((left, right) => (numberValue(left.pk) ?? 0) - (numberValue(right.pk) ?? 0))
    .map((row) => stringValue(row.name));
  return (
    columns.length === expectedColumns.length &&
    expectedColumns.every((column, position) => columns[position] === column)
  );
}

function tableInfo(db: DatabaseSync, table: string): Record<string, unknown>[] {
  if (!/^[a-z_]+$/.test(table)) return [];
  return db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
}

function hasPartialUniqueIndex(
  db: DatabaseSync,
  indexName: string,
  expectedColumns: readonly string[],
  expectedPredicate: string,
): boolean {
  const index = (
    db.prepare('PRAGMA index_list(child_sessions)').all() as Record<string, unknown>[]
  ).find((row) => stringValue(row.name) === indexName);
  if (!index || numberValue(index.unique) !== 1 || numberValue(index.partial) !== 1) return false;
  const columns = (
    db.prepare(`PRAGMA index_info(${indexName})`).all() as Record<string, unknown>[]
  ).map((row) => stringValue(row.name));
  const schema = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
    .get(indexName) as Record<string, unknown> | undefined;
  const sql = stringValue(schema?.sql)?.toLowerCase().replace(/\s+/g, ' ').trim().replace(/;$/, '');
  const expectedSql = `create unique index ${indexName} on child_sessions (${expectedColumns.join(', ')}) where ${expectedPredicate}`;
  return (
    columns.length === expectedColumns.length &&
    expectedColumns.every((column, position) => columns[position] === column) &&
    sql === expectedSql
  );
}

function childSchemaHasChecks(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'child_sessions'")
    .get() as Record<string, unknown> | undefined;
  const sql = stringValue(row?.sql)?.toLowerCase().replace(/\s+/g, ' ');
  return Boolean(sql && CHILD_SCHEMA_CHECKS.every((check) => sql.includes(check)));
}

function assertCanonicalHistorySchema(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
  if (
    (numberValue(row?.user_version) ?? 0) !== HISTORY_SCHEMA_VERSION ||
    !hasCanonicalChildSchema(db)
  )
    throw new Error(HISTORY_SCHEMA_RECOVERY);
}

function persistedChildSessionFromRow(row: Record<string, unknown>): PersistedChildSession {
  const parentAppSessionId = stringValue(row.parent_app_session_id);
  const childSessionId = stringValue(row.child_session_id);
  const role = persistedChildRole(row.role);
  const status = persistedChildStatus(row.status);
  const modelId = stringValue(row.model_id);
  const updatedAt = numberValue(row.updated_at);
  if (!parentAppSessionId || !childSessionId || !modelId || updatedAt === undefined)
    throw new Error(HISTORY_SCHEMA_RECOVERY);
  const spawnLink = persistedChildSpawnLink(row);
  return {
    parentAppSessionId,
    childSessionId,
    ...whenString(row.provider_session_id, (providerSessionId) => ({ providerSessionId })),
    role,
    ...whenString(row.label, (label) => ({ label })),
    ...whenString(row.prompt, (prompt) => ({ prompt })),
    status,
    modelId,
    ...whenReasoning(row.reasoning_effort),
    ...(spawnLink ? { spawnLink } : {}),
    transcriptAvailable: numberValue(row.transcript_available) === 1,
    ...whenNumber(row.started_at, (startedAt) => ({ startedAt })),
    updatedAt,
  };
}

function persistedChildRole(value: unknown): PersistedChildRole {
  const role = stringValue(value);
  if (role === 'worker' || role === 'validator') return role;
  throw new Error(HISTORY_SCHEMA_RECOVERY);
}

function persistedChildStatus(value: unknown): PersistedChildStatus {
  const status = stringValue(value);
  if (status === 'pending' || status === 'running' || status === 'paused' || status === 'completed')
    return status;
  throw new Error(HISTORY_SCHEMA_RECOVERY);
}

function persistedChildSpawnLink(
  row: Record<string, unknown>,
): PersistedChildSpawnLink | undefined {
  const kind = stringValue(row.spawn_link_kind);
  const id = stringValue(row.spawn_link_id);
  if (kind === undefined && id === undefined) return undefined;
  if ((kind === 'tool-use' || kind === 'spawn') && id) return { kind, id };
  throw new Error(HISTORY_SCHEMA_RECOVERY);
}

function whenString<T extends object>(
  value: unknown,
  create: (value: string) => T,
): T | Record<string, never> {
  const resolved = stringValue(value);
  return resolved === undefined ? {} : create(resolved);
}

function whenNumber<T extends object>(
  value: unknown,
  create: (value: number) => T,
): T | Record<string, never> {
  const resolved = numberValue(value);
  return resolved === undefined ? {} : create(resolved);
}

function whenReasoning(
  value: unknown,
): { reasoningEffort: ReasoningEffort } | Record<string, never> {
  const reasoningEffort = mapReasoning(stringValue(value));
  return reasoningEffort === undefined ? {} : { reasoningEffort };
}

function readStoredSummaryPatches(): Map<string, Partial<SessionSummary>> {
  const path = join(homedir(), '.factory', 'droid-control', SESSION_INDEX_FILENAME);
  if (!existsSync(path)) return new Map();
  const db = new DatabaseSync(path);
  try {
    assertCanonicalHistorySchema(db);
    const rows = db.prepare('SELECT * FROM app_sessions').all() as Record<string, unknown>[];
    return summaryPatchesFromRows(rows);
  } finally {
    db.close();
  }
}

function readStoredChildSessions(parentAppSessionId: string): PersistedChildSession[] {
  const path = join(homedir(), '.factory', 'droid-control', SESSION_INDEX_FILENAME);
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path);
  try {
    assertCanonicalHistorySchema(db);
    const rows = db
      .prepare(
        'SELECT * FROM child_sessions WHERE parent_app_session_id = ? ORDER BY updated_at ASC, child_session_id ASC',
      )
      .all(parentAppSessionId) as Record<string, unknown>[];
    return rows.map(persistedChildSessionFromRow);
  } finally {
    db.close();
  }
}

function summaryPatchesFromRows(
  rows: Record<string, unknown>[],
): Map<string, Partial<SessionSummary>> {
  const patches = new Map<string, Partial<SessionSummary>>();
  for (const row of rows) {
    const appSessionId = stringValue(row.app_session_id);
    const providerSessionId = stringValue(row.provider_session_id);
    if (!appSessionId || !providerSessionId) continue;
    const patch: Partial<SessionSummary> = {
      appSessionId,
      providerSessionId,
      compactedFromProviderSessionIds: jsonStringArray(row.compacted_from_provider_session_ids),
      sessionPurpose: sessionPurpose(stringValue(row.session_purpose)),
      interactionMode: sessionInteractionModeValue(stringValue(row.interaction_mode)),
      title: stringValue(row.title),
      cwd: stringValue(row.cwd),
      workspaceKind: workspaceKind(stringValue(row.workspace_kind)),
      modelId: stringValue(row.model_id),
      reasoningEffort: mapReasoning(stringValue(row.reasoning_effort)),
      compactionModel: stringValue(row.compaction_model),
      workerModelId: stringValue(row.worker_model_id),
      workerReasoningEffort: mapReasoning(stringValue(row.worker_reasoning_effort)),
      validatorModelId: stringValue(row.validator_model_id),
      validatorReasoningEffort: mapReasoning(stringValue(row.validator_reasoning_effort)),
      autonomy: mapAutonomy(stringValue(row.autonomy)),
      tokensIn: numberValue(row.tokens_in),
      tokensOut: numberValue(row.tokens_out),
      contextTokens: numberValue(row.context_tokens),
      contextRemainingTokens: numberValue(row.context_remaining_tokens),
      contextAccuracy: contextAccuracy(row.context_accuracy),
      contextUpdatedAt: stringValue(row.context_updated_at),
      maxContextTokens: numberValue(row.max_context_tokens),
      autoCompactions: numberValue(row.auto_compactions),
      updatedAt: numberValue(row.updated_at),
    };
    patches.set(appSessionId, patch);
    patches.set(providerSessionId, patch);
  }
  return patches;
}

export function applyCachedSummary(
  summary: SessionSummary,
  cached: Map<string, Partial<SessionSummary>>,
): SessionSummary {
  const patch =
    cached.get(summary.providerSessionId ?? summary.appSessionId) ??
    cached.get(summary.appSessionId);
  if (!patch) return summary;
  const defined = definedPatch(patch);
  return {
    ...summary,
    ...defined,
    appSessionId: defined.appSessionId ?? summary.appSessionId,
    providerSessionId: defined.providerSessionId ?? summary.providerSessionId,
    missionId: defined.missionId ?? summary.missionId,
    sessionPurpose: defined.sessionPurpose ?? summary.sessionPurpose,
    interactionMode: defined.interactionMode ?? summary.interactionMode,
    role: defined.role ?? summary.role,
  };
}

function definedPatch(patch: Partial<SessionSummary>): Partial<SessionSummary> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<SessionSummary>;
}

export function hydrateHistoricalSession(
  missionId: string,
  opts: { cursor?: string; limit?: number } = {},
): HydratedSessionHistory {
  const dir = resolveMissionDir(missionId);
  if (!dir) throw new Error(`Mission history not found for ${missionId}`);

  const { summary, storedProgress } = loadMissionControlSession(dir);
  const progress = projectMissionProgress(
    storedProgress,
    readStoredChildSessions(summary.appSessionId),
  );
  const sessionIndex = buildSessionIndex();

  // The orchestrator backing session is rekeyed on every compaction, so the
  // full conversation is spread across a CHAIN of session files. Resolve that
  // chain (oldest -> newest) from the persisted app-session row; replaying only
  // the latest segment is what made compacted chats lose their scrollback.
  const chain = orchestratorChain(summary, sessionIndex);
  const window = loadSessionTranscriptWindow(summary.appSessionId, chain, opts);

  // Older pages only extend the orchestrator scrollback upward; workers and
  // progress were already delivered with the initial (newest) page.
  if (opts.cursor) {
    return { progress: [], transcripts: window.events, olderCursor: window.olderCursor };
  }

  return { progress, transcripts: window.events, olderCursor: window.olderCursor };
}

// Resolve the orchestrator's compaction chain (oldest -> newest backing session
// ids) for a mission. The persisted app-session row keeps the authoritative
// chain (previous backing ids + current); fall back to the summary when it is
// already hydrated with one. Filtered to ids that still have a session file.
function orchestratorChain(summary: SessionSummary, sessionIndex: Map<string, string>): string[] {
  const patches = readStoredSummaryPatches();
  const patch =
    patches.get(summary.appSessionId) ??
    patches.get(summary.providerSessionId ?? summary.appSessionId);
  const currentSession =
    patch?.providerSessionId ?? summary.providerSessionId ?? summary.appSessionId;
  const compactedFrom =
    patch?.compactedFromProviderSessionIds ?? summary.compactedFromProviderSessionIds ?? [];
  return dedupeStrings([summary.appSessionId, ...compactedFrom, currentSession]).filter((id) =>
    sessionIndex.has(id),
  );
}

// Resolve the compaction chain (oldest -> newest backing session ids) for a
// plain chat / spec session that has no Mission Control directory. Such sessions never
// reach hydrateHistoricalSession, so without this they would replay only the
// newest backing file and lose all pre-compaction scrollback. Reads the chain
// straight from the persisted app-session row (keyed by either id) and filters
// to ids that still have a session file on disk.
export function resolveSessionChain(appSessionId: string, providerSessionId: string): string[] {
  const sessionIndex = buildSessionIndex();
  const patches = readStoredSummaryPatches();
  const patch = patches.get(appSessionId) ?? patches.get(providerSessionId);
  const currentSession = patch?.providerSessionId ?? providerSessionId;
  const compactedFrom = patch?.compactedFromProviderSessionIds ?? [];
  return dedupeStrings([appSessionId, ...compactedFrom, currentSession]).filter((id) =>
    sessionIndex.has(id),
  );
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

interface CompactionState {
  removedCount?: number;
  ts: number;
}

// Read the leading compaction_state record a compacted session begins with.
// It marks the boundary where earlier turns were summarized away; we surface it
// as a subtle "context compacted" divider rather than replaying the summary.
// Reads from the HEAD of the file (compaction_state is a leading record); the
// transcript reader tail-windows oversized files and would miss it.
function readCompactionState(path: string): CompactionState | null {
  const size = statSync(path).size;
  const bytes = Math.min(size, SESSION_START_BYTES);
  const fd = openSync(path, 'r');
  let rows: Array<{ type?: string; timestamp?: string; removedCount?: unknown }>;
  try {
    const buffer = Buffer.alloc(bytes);
    readSync(fd, buffer, 0, bytes, 0);
    rows = parseJsonLines(buffer.toString('utf8'));
  } finally {
    closeSync(fd);
  }
  for (const row of rows) {
    if (row.type === 'session_start') continue;
    if (row.type === 'compaction_state') {
      return { removedCount: numberValue(row.removedCount), ts: dateMs(row.timestamp) || 0 };
    }
    return null;
  }
  return null;
}

function compactionDividerEvent(
  appSessionId: string,
  providerSessionId: string,
  comp: CompactionState,
): TranscriptEvent {
  return {
    id: `${providerSessionId}:compaction`,
    appSessionId,
    sourceSessionId: 'primary',
    role: 'primary',
    ts: comp.ts,
    kind: 'compaction',
    removedCount: comp.removedCount,
  };
}

// The chronological items for one chain segment: a leading compaction divider
// (when the file actually starts with a compaction_state) followed by that
// file's messages. The divider is detected by reading the record itself rather
// than the segment's position, so an in-place-compacted single segment - or the
// oldest reachable segment once earlier files have been pruned - still surfaces
// it instead of silently dropping the boundary.
function segmentItems(
  appSessionId: string,
  providerSessionId: string,
  path: string,
): TranscriptEvent[] {
  const items: TranscriptEvent[] = [];
  const parsed = parseSessionTranscript(appSessionId, providerSessionId, path, 'primary');
  // The head read backstops oversized files whose leading compaction_state was
  // tail-windowed away; when the parse already replayed that same record as a
  // divider, adding the head copy would duplicate it.
  const comp = readCompactionState(path);
  if (comp && !parsed.some((e) => e.kind === 'compaction' && e.ts === comp.ts))
    items.push(compactionDividerEvent(appSessionId, providerSessionId, comp));
  items.push(...parsed);
  return items;
}

// Window the primary transcript backward across the compaction chain.
// Reads files newest -> oldest only as far as needed to fill `limit`, so a
// months-long, heavily-compacted chat opens fast and pages older history in on
// demand. The cursor is "<chainIdx>:<itemEnd>" ('end' = the file's tail).
export function loadSessionTranscriptWindow(
  appSessionId: string,
  chainProviderSessionIds: string[],
  opts: { cursor?: string; limit?: number } = {},
): { events: TranscriptEvent[]; olderCursor?: string } {
  const limit = Math.max(1, opts.limit ?? DEFAULT_HISTORY_WINDOW);
  const sessionIndex = buildSessionIndex();
  const chain = chainProviderSessionIds.filter((id) => sessionIndex.has(id));
  if (chain.length === 0) return { events: [] };

  let startIdx: number;
  let end: number;
  if (opts.cursor) {
    const [ciStr, endStr] = opts.cursor.split(':');
    startIdx = Number(ciStr);
    end = endStr === 'end' ? Infinity : Number(endStr);
    if (!Number.isInteger(startIdx) || startIdx < 0 || startIdx >= chain.length)
      return { events: [] };
  } else {
    startIdx = chain.length - 1;
    end = Infinity;
  }

  const picked: TranscriptEvent[] = [];
  let olderCursor: string | undefined;
  for (let ci = startIdx; ci >= 0; ci--) {
    const path = sessionIndex.get(chain[ci])!;
    const items = segmentItems(appSessionId, chain[ci], path);
    let start = ci === startIdx ? Math.min(end, items.length) : items.length;
    while (start > 0 && picked.length < limit) {
      start--;
      // Chain-derived monotonic order: older segments (lower ci) and earlier
      // positions sort first, independent of wall-clock ts. SEQ_SEGMENT_STRIDE
      // exceeds any single segment's windowed item count, so the global order
      // is preserved across pages without re-reading older segments.
      picked.push({ ...items[start], seq: ci * SEQ_SEGMENT_STRIDE + start });
    }
    if (picked.length >= limit) {
      if (start > 0) olderCursor = `${ci}:${start}`;
      else if (ci > 0) olderCursor = `${ci - 1}:end`;
      break;
    }
    end = Infinity;
  }

  picked.reverse();
  return { events: picked, olderCursor };
}

export function readFactoryDefaults(): FactoryDefaults {
  const path = join(homedir(), '.factory', 'settings.json');
  if (!existsSync(path)) return {};
  const settings = readJson<Record<string, unknown>>(path);
  const session = objectValue(settings.sessionDefaultSettings) ?? {};
  const missionControlSettings = objectValue(settings.missionModelSettings) ?? {};
  return {
    modelId: stringValue(session.model) || stringValue(session.modelId),
    reasoningEffort: mapReasoning(stringValue(session.reasoningEffort)),
    compactionModel: stringValue(settings.compactionModel) || stringValue(session.compactionModel),
    compactionTokenLimit: tokenLimitValue(settings.compactionTokenLimit),
    compactionTokenLimitPerModel: tokenLimitRecordValue(settings.compactionTokenLimitPerModel),
    autonomy: mapAutonomy(stringValue(session.autonomyLevel)),
    interactionMode: mapInteractionMode(stringValue(session.interactionMode)),
    specModelId: stringValue(session.specModeModel),
    specReasoningEffort: mapReasoning(stringValue(session.specModeReasoningEffort)),
    missionOrchestratorModelId: stringValue(settings.missionOrchestratorModel),
    missionOrchestratorReasoningEffort: mapReasoning(
      stringValue(settings.missionOrchestratorReasoningEffort),
    ),
    workerModelId: stringValue(missionControlSettings.workerModel),
    workerReasoningEffort: mapReasoning(stringValue(missionControlSettings.workerReasoningEffort)),
    validatorModelId: stringValue(missionControlSettings.validationWorkerModel),
    validatorReasoningEffort: mapReasoning(
      stringValue(missionControlSettings.validationWorkerReasoningEffort),
    ),
  };
}

function mapInteractionMode(value?: string): FactoryDefaults['interactionMode'] {
  if (value === 'auto' || value === 'spec' || value === 'agi') return value;
  return undefined;
}

function tokenLimitValue(value: unknown): number | undefined {
  return normalizeCompactionTokenLimit(value);
}

function tokenLimitRecordValue(value: unknown): Record<string, number> | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const entries = Object.entries(record)
    .map(([modelId, limit]) => [modelId, tokenLimitValue(limit)] as const)
    .filter((entry): entry is [string, number] => entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function loadMissionControlSession(dir: string): HistoricalSession & {
  state: StoredMissionState;
  features: BridgeFeature[];
  storedProgress: StoredProgressEntry[];
} {
  const state = readJson<StoredMissionState>(join(dir, 'state.json'));
  const storedProgress = readProgress(join(dir, 'progress_log.jsonl'));
  const progress = storedProgress.map(publicProgressEntry);
  const features = readFeatures(join(dir, 'features.json'));
  const dirId = basename(dir);
  const providerSessionId = state.baseSessionId || dirId;
  const firstProgressTitle = progress.find((p) => p.title)?.title;
  const cwd = state.workingDirectory || state.cwd || '';
  const title =
    firstProgressTitle ||
    state.missionId ||
    lastPathSegment(cwd) ||
    `Mission ${providerSessionId.slice(0, 8)}`;
  const createdAt =
    dateMs(state.createdAt) || dateMs(progress[0]?.timestamp) || statSync(dir).birthtimeMs;
  const updatedAt =
    dateMs(state.updatedAt) ||
    dateMs(progress[progress.length - 1]?.timestamp) ||
    statSync(dir).mtimeMs;
  const modelSettings = readMissionModelSettings(dir);

  return {
    summary: {
      appSessionId: providerSessionId,
      providerSessionId,
      missionId: state.missionId ?? dirId,
      sessionPurpose: 'mission-control',
      interactionMode: 'agi',
      role: 'primary',
      title,
      goal: progress[0]?.message || title,
      cwd,
      workspaceKind: cwd ? 'folder' : 'none',
      ...modelSettings,
      autonomy: modelSettings.autonomy ?? 'medium',
      phase: STATE_TO_PHASE[String(state.state ?? '')] ?? 'paused',
      features,
      tokensIn: 0,
      tokensOut: 0,
      contextTokens: 0,
      createdAt,
      updatedAt,
    },
    progress,
    storedProgress,
    state,
    features,
  };
}

function readMissionModelSettings(dir: string): FactoryDefaults {
  const path = join(dir, 'model-settings.json');
  if (!existsSync(path)) return {};
  const settings = readJson<StoredModelSettings>(path);
  return {
    modelId: settings.model || settings.modelId,
    reasoningEffort: mapReasoning(settings.reasoningEffort),
    compactionModel: settings.compactionModel,
    compactionTokenLimit: tokenLimitValue(settings.compactionTokenLimit),
    compactionTokenLimitPerModel: tokenLimitRecordValue(settings.compactionTokenLimitPerModel),
    workerModelId: settings.workerModel,
    workerReasoningEffort: mapReasoning(settings.workerReasoningEffort),
    validatorModelId: settings.validationWorkerModel,
    validatorReasoningEffort: mapReasoning(settings.validationWorkerReasoningEffort),
    autonomy: mapAutonomy(settings.autonomyLevel),
  };
}

function readProgress(path: string): StoredProgressEntry[] {
  if (!existsSync(path)) return [];
  return readJsonLines<Record<string, unknown>>(path).map((entry) => {
    const handoff = objectValue(entry.handoff);
    const validation = objectValue(entry.validation);
    return {
      type: stringValue(entry.type) || 'entry',
      timestamp: stringValue(entry.timestamp) || new Date().toISOString(),
      title: stringValue(entry.title) || titleFromProgressType(stringValue(entry.type)),
      message:
        stringValue(entry.message) ||
        stringValue(handoff?.salientSummary) ||
        stringValue(validation?.summary) ||
        stringValue(entry.reason),
      featureId: stringValue(entry.featureId),
      ...whenString(entry.workerSessionId, (workerProviderSessionId) => ({
        workerProviderSessionId,
      })),
      ...whenString(entry.spawnId, (spawnId) => ({ spawnId })),
    };
  });
}

export function projectMissionProgress(
  entries: StoredProgressEntry[],
  children: PersistedChildSession[],
): ProgressEntry[] {
  const childrenBySpawn = new Map(
    children.flatMap((child) =>
      child.spawnLink?.kind === 'spawn'
        ? [[child.spawnLink.id, child.childSessionId] as const]
        : [],
    ),
  );
  const childrenByProvider = new Map<string, string>();
  const correlatedSpawns = new Map<string, string>();
  const providerBySpawn = new Map<string, string>();
  const spawnByProvider = new Map<string, string>();
  const retiredProviders = new Set<string>();
  return entries.map((entry) => {
    if (
      entry.type === 'worker_started' &&
      entry.workerProviderSessionId &&
      entry.spawnId &&
      !retiredProviders.has(entry.workerProviderSessionId) &&
      (!spawnByProvider.has(entry.workerProviderSessionId) ||
        spawnByProvider.get(entry.workerProviderSessionId) === entry.spawnId)
    ) {
      const childSessionId = childrenBySpawn.get(entry.spawnId);
      if (childSessionId) {
        const previousProviderSessionId = providerBySpawn.get(entry.spawnId);
        if (
          previousProviderSessionId &&
          previousProviderSessionId !== entry.workerProviderSessionId
        ) {
          childrenByProvider.delete(previousProviderSessionId);
          retiredProviders.add(previousProviderSessionId);
        }
        childrenByProvider.set(entry.workerProviderSessionId, childSessionId);
        correlatedSpawns.set(entry.spawnId, childSessionId);
        providerBySpawn.set(entry.spawnId, entry.workerProviderSessionId);
        spawnByProvider.set(entry.workerProviderSessionId, entry.spawnId);
      }
    }
    const byProvider =
      entry.workerProviderSessionId && !retiredProviders.has(entry.workerProviderSessionId)
        ? childrenByProvider.get(entry.workerProviderSessionId)
        : undefined;
    const bySpawn = entry.spawnId ? correlatedSpawns.get(entry.spawnId) : undefined;
    const childSessionId =
      entry.workerProviderSessionId && entry.spawnId
        ? providerBySpawn.get(entry.spawnId) === entry.workerProviderSessionId &&
          byProvider === bySpawn
          ? byProvider
          : undefined
        : (byProvider ?? bySpawn);
    const publicEntry = publicProgressEntry(entry);
    return childSessionId ? { ...publicEntry, workerChildSessionId: childSessionId } : publicEntry;
  });
}

function publicProgressEntry(entry: StoredProgressEntry): ProgressEntry {
  const publicEntry = { ...entry };
  delete publicEntry.workerProviderSessionId;
  delete publicEntry.spawnId;
  return publicEntry;
}

function readFeatures(path: string): BridgeFeature[] {
  if (!existsSync(path)) return [];
  const file = readJson<StoredFeatureFile>(path);
  return (file.features ?? []).map((feature) => mapStoredFeature(feature));
}

function mapStoredFeature(feature: unknown): BridgeFeature {
  try {
    return mapFeature(feature as never);
  } catch {
    const f = objectValue(feature) ?? {};
    return {
      id: stringValue(f.id) || 'feature',
      description: stringValue(f.description) || stringValue(f.id) || 'Feature',
      status: mapFeatureStatus(stringValue(f.status)),
      skillName: stringValue(f.skillName) || '',
      preconditions: stringArray(f.preconditions),
      expectedBehavior: stringArray(f.expectedBehavior),
      verificationSteps: stringArray(f.verificationSteps),
      fulfills: stringArray(f.fulfills),
      milestone: stringValue(f.milestone),
    };
  }
}

function parseSessionTranscript(
  appSessionId: string,
  providerSessionId: string,
  path: string,
  role: SessionRole,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const sessionLines = readSessionJsonLines<StoredMessageLine | StoredSessionStart>(path);
  if (sessionLines.trimmed) {
    events.push(
      event(
        appSessionId,
        providerSessionId,
        role,
        'history-window',
        0,
        statSync(path).mtimeMs,
        'status',
        {
          text: `Loaded latest ${Math.round(MAX_SESSION_BYTES / 1_000_000)} MB of this oversized session for UI performance.`,
        },
      ),
    );
  }
  for (const line of sessionLines.rows) {
    // In-place daemon auto-compaction appends a compaction_state marker to the
    // SAME session file, so a mid-file record marks a summarize-away boundary
    // that must replay as a divider (leading records are handled by the
    // segment's head read, which segmentItems dedupes against).
    if (line.type === 'compaction_state') {
      const raw = line as Record<string, unknown>;
      const ts = dateMs(stringValue(raw.timestamp)) || 0;
      events.push(
        event(
          appSessionId,
          providerSessionId,
          role,
          line.id || `compaction-${ts}`,
          0,
          ts,
          'compaction',
          {
            removedCount: numberValue(raw.removedCount),
          },
        ),
      );
      continue;
    }
    if (line.type !== 'message' || !('message' in line)) continue;
    const message = line.message;
    const content = Array.isArray(message?.content) ? message.content : [];
    const ts = dateMs(line.timestamp) || Date.now();
    const messageId = line.id || `${providerSessionId}-${ts}`;
    const messageRole = message?.role;

    content.forEach((item, index) => {
      const block = objectValue(item);
      if (!block) return;
      const type = stringValue(block.type);
      if (messageRole === 'assistant') {
        if (type === 'thinking') {
          const text = trimText(stringValue(block.thinking) || stringValue(block.text) || '');
          if (text)
            events.push(
              event(appSessionId, providerSessionId, role, messageId, index, ts, 'thinking', {
                text,
              }),
            );
        } else if (type === 'text') {
          const text = trimText(stringValue(block.text) || '');
          if (text)
            events.push(
              event(appSessionId, providerSessionId, role, messageId, index, ts, 'text', {
                text,
              }),
            );
        } else if (type === 'tool_use') {
          events.push(
            event(appSessionId, providerSessionId, role, messageId, index, ts, 'tool_call', {
              toolName: stringValue(block.name) || 'tool',
              toolArgs: block.input,
              // Carry the tool_use id so persisted child-session links resolve exactly
              // (duplicate-label spawns would otherwise fall back to label match).
              toolUseId: stringValue(block.id),
            }),
          );
        }
        return;
      }

      if (type === 'tool_result') {
        const contentText = stringifyToolResult(block.content);
        events.push(
          event(appSessionId, providerSessionId, role, messageId, index, ts, 'tool_result', {
            toolName: stringValue(block.name),
            text: trimText(contentText),
            isError: Boolean(block.is_error ?? block.isError),
            // Carry the originating call's id so the renderer can correlate a
            // result to its tool_call exactly (result blocks have no name and
            // may not be adjacent to their call after replay/batching).
            toolUseId: stringValue(block.tool_use_id ?? block.toolUseId) || undefined,
          }),
        );
      } else if (messageRole === 'user' && role === 'primary' && type === 'text') {
        const rawText = trimText(stringValue(block.text) || '');
        const display = designPromptDisplayFromText(rawText);
        const text = display?.text ?? rawText;
        if (text && !isSystemText(text)) {
          events.push(
            event(appSessionId, 'user', 'primary', messageId, index, ts, 'text', {
              text,
              author: 'user',
              browserRefs: display?.browserRefs,
            }),
          );
        }
      }
    });
  }
  return events;
}

function event(
  appSessionId: string,
  sourceProviderSessionId: string,
  role: SessionRole,
  messageId: string,
  index: number,
  ts: number,
  kind: TranscriptEvent['kind'],
  extra: Partial<TranscriptEvent>,
): TranscriptEvent {
  return {
    id: `${sourceProviderSessionId}:${messageId}:${index}:${kind}`,
    appSessionId,
    sourceSessionId:
      role === 'primary' && sourceProviderSessionId !== 'user'
        ? 'primary'
        : sourceProviderSessionId,
    role,
    ts,
    kind,
    ...extra,
  };
}

function missionDirs(): string[] {
  const root = join(homedir(), '.factory', 'missions');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory() && existsSync(join(path, 'state.json'));
      } catch {
        return false;
      }
    });
}

function resolveMissionDir(missionId: string): string | null {
  for (const dir of missionDirs()) {
    const state = readJson<StoredMissionState>(join(dir, 'state.json'));
    if (
      basename(dir) === missionId ||
      state.baseSessionId === missionId ||
      state.missionId === missionId
    )
      return dir;
  }
  return null;
}

function limitHistoricalRows(
  rows: HistoricalSession[],
  workspaceCwds: Set<string> | null,
  limitPerWorkspace?: number,
  includePlainChats?: boolean,
): HistoricalSession[] {
  if (!workspaceCwds && !includePlainChats) return rows;
  // An omitted limit means "no cap" so the sidebar can load every persisted
  // session and reveal the older ones behind "Show more".
  const limit =
    limitPerWorkspace === undefined ? undefined : Math.max(1, Math.min(limitPerWorkspace, 50));
  const cap = <T>(items: T[]): T[] => (limit === undefined ? items : items.slice(0, limit));
  const limited: HistoricalSession[] = [];
  if (includePlainChats) {
    limited.push(...cap(rows.filter((row) => !row.summary.cwd)));
  }
  for (const cwd of workspaceCwds ?? []) {
    limited.push(...cap(rows.filter((row) => row.summary.cwd === cwd)));
  }
  return limited.sort((a, b) => b.summary.updatedAt - a.summary.updatedAt);
}

function shouldIncludeCwd(
  cwd: string,
  workspaceCwds: Set<string> | null,
  includePlainChats?: boolean,
): boolean {
  if (!cwd) return Boolean(includePlainChats);
  if (!workspaceCwds) return false;
  return workspaceCwds.has(cwd);
}

function buildSessionIndex(): Map<string, string> {
  const root = join(homedir(), '.factory', 'sessions');
  const index = new Map<string, string>();
  if (!existsSync(root)) return index;

  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (name.endsWith('.jsonl')) index.set(name.slice(0, -'.jsonl'.length), path);
    }
  };
  walk(root, 0);
  return index;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readJsonLines<T>(path: string): T[] {
  return parseJsonLines(readFileSync(path, 'utf8'));
}

function readSessionJsonLines<T>(path: string): { rows: T[]; trimmed: boolean } {
  const size = statSync(path).size;
  if (size <= MAX_SESSION_BYTES) return { rows: readJsonLines<T>(path), trimmed: false };

  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_SESSION_BYTES);
    readSync(fd, buffer, 0, MAX_SESSION_BYTES, size - MAX_SESSION_BYTES);
    const raw = buffer.toString('utf8');
    const firstNewline = raw.indexOf('\n');
    return {
      rows: parseJsonLines<T>(firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw),
      trimmed: true,
    };
  } finally {
    closeSync(fd);
  }
}

function readSessionStart(path: string): StoredSessionStart {
  const size = statSync(path).size;
  const bytes = Math.min(size, SESSION_START_BYTES);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    // The session_start record is the first JSONL line, so decode and parse only
    // the leading lines instead of the whole (up to 256 KB) head. The session
    // list reads every session file on startup, so parsing one line instead of
    // thousands is what keeps the sidebar fast to populate.
    let offset = 0;
    for (let i = 0; i < 8 && offset < read; i++) {
      let nl = buffer.indexOf(0x0a, offset);
      if (nl < 0 || nl > read) nl = read;
      const line = buffer.toString('utf8', offset, nl).trim();
      offset = nl + 1;
      if (!line) continue;
      try {
        const row = JSON.parse(line) as StoredSessionStart;
        if (row.type === 'session_start') return row;
      } catch {
        // Not a complete JSON line yet; keep scanning the first few lines.
      }
    }
    return {};
  } finally {
    closeSync(fd);
  }
}

function classifyStoredSession(
  start: StoredSessionStart,
): Pick<SessionSummary, 'sessionPurpose' | 'interactionMode' | 'role' | 'missionId'> | null {
  if (start.decompSessionType === 'worker') return null;
  if (start.decompSessionType === 'validator') return null;
  // Factory Task-tool children are never standalone conversations.
  if (start.callingSessionId || start.callingToolUseId) return null;
  const mode = sessionInteractionMode(start);
  const missionControlId = start.decompMissionId;
  if (start.decompSessionType === 'orchestrator' || missionControlId) {
    return {
      sessionPurpose: 'mission-control',
      interactionMode: 'agi',
      role: 'primary',
      missionId: missionControlId,
    };
  }
  if (mode === 'spec') {
    return {
      sessionPurpose: 'chat',
      interactionMode: 'spec',
      role: 'primary',
      missionId: undefined,
    };
  }
  return {
    sessionPurpose: 'chat',
    interactionMode: mode === 'agi' ? 'agi' : 'auto',
    role: 'primary',
    missionId: undefined,
  };
}

function sessionInteractionMode(start: StoredSessionStart): string | undefined {
  const direct = objectValue(start)?.interactionMode;
  const settings = objectValue(objectValue(start)?.settings);
  return stringValue(direct) ?? stringValue(settings?.interactionMode);
}

function readSessionModelSettings(start: StoredSessionStart, sessionPath: string): FactoryDefaults {
  const raw = objectValue(start) ?? {};
  const settings = objectValue(raw.settings) ?? objectValue(raw.sessionSettings) ?? {};
  const sidecarSettings = readAdjacentSessionSettings(sessionPath);
  return {
    modelId:
      stringValue(sidecarSettings.modelId) ||
      stringValue(sidecarSettings.model) ||
      stringValue(settings.modelId) ||
      stringValue(settings.model) ||
      stringValue(raw.modelId) ||
      stringValue(raw.model),
    reasoningEffort: mapReasoning(
      stringValue(sidecarSettings.reasoningEffort) ||
        stringValue(settings.reasoningEffort) ||
        stringValue(raw.reasoningEffort),
    ),
    compactionModel:
      stringValue(sidecarSettings.compactionModel) ||
      stringValue(settings.compactionModel) ||
      stringValue(raw.compactionModel),
    compactionTokenLimit:
      tokenLimitValue(sidecarSettings.compactionTokenLimit) ??
      tokenLimitValue(settings.compactionTokenLimit) ??
      tokenLimitValue(raw.compactionTokenLimit),
    compactionTokenLimitPerModel:
      tokenLimitRecordValue(sidecarSettings.compactionTokenLimitPerModel) ??
      tokenLimitRecordValue(settings.compactionTokenLimitPerModel) ??
      tokenLimitRecordValue(raw.compactionTokenLimitPerModel),
    autonomy: mapAutonomy(
      stringValue(sidecarSettings.autonomyLevel) ||
        stringValue(settings.autonomyLevel) ||
        stringValue(raw.autonomyLevel),
    ),
  };
}

function readAdjacentSessionSettings(sessionPath: string): Record<string, unknown> {
  const settingsPath = sessionPath.replace(/\.jsonl$/, '.settings.json');
  if (!existsSync(settingsPath)) return {};
  try {
    return readJson<Record<string, unknown>>(settingsPath);
  } catch {
    return {};
  }
}

function countSessionMessages(path: string): number {
  return readSessionJsonLines<StoredMessageLine>(path).rows.filter(
    (line) => line.type === 'message',
  ).length;
}

function parseJsonLines<T>(raw: string): T[] {
  const rows: T[] = [];
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      /* skip partial/corrupt JSONL rows */
    }
  });
  return rows;
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const block = objectValue(item);
        return stringValue(block?.text) || safeStringify(item);
      })
      .filter(Boolean)
      .join('\n');
  }
  return safeStringify(value);
}

function trimText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated ${text.length - MAX_TEXT_CHARS} chars]`;
}

function isSystemText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('<system-reminder>') || trimmed.startsWith('IMPORTANT:');
}

function titleFromProgressType(type?: string): string | undefined {
  if (!type) return undefined;
  return type.replace(/_/g, ' ');
}

function mapFeatureStatus(status?: string): FeatureStatus {
  if (status === 'in_progress' || status === 'completed' || status === 'cancelled') return status;
  return 'pending';
}

function mapReasoning(value?: string): ReasoningEffort | undefined {
  if (
    value === 'off' ||
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'dynamic'
  ) {
    return value;
  }
  return undefined;
}

function mapAutonomy(value?: string): Autonomy | undefined {
  if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

function contextAccuracy(value: unknown): SessionSummary['contextAccuracy'] | undefined {
  if (value === 'exact' || value === 'estimated') return value;
  return undefined;
}

function sessionPurpose(value?: string): SessionSummary['sessionPurpose'] | undefined {
  if (value === 'chat' || value === 'design' || value === 'mission-control') return value;
  return undefined;
}

function sessionInteractionModeValue(
  value?: string,
): SessionSummary['interactionMode'] | undefined {
  if (value === 'auto' || value === 'spec' || value === 'agi') return value;
  return undefined;
}

function workspaceKind(value?: string): SessionSummary['workspaceKind'] | undefined {
  if (value === 'folder' || value === 'none') return value;
  return undefined;
}

function sqlValue(value: string | number | undefined): string | number | null {
  return value ?? null;
}

function roleFromSessionStart(start: StoredSessionStart): SessionRole {
  if (start.decompSessionType === 'validator') return 'validator';
  if (start.decompSessionType === 'worker') return 'worker';
  // Factory Task-tool children carry no decompSessionType but have a parent
  // session's tool call (callingSessionId/callingToolUseId). Replay them as
  // workers so their transcript keys to their own session id instead of being
  // folded into 'primary' (which would leave the opened child blank).
  if (start.callingSessionId || start.callingToolUseId) return 'worker';
  return 'primary';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function jsonStringArray(value: unknown): string[] {
  const raw = stringValue(value);
  if (!raw) return [];
  try {
    return stringArray(JSON.parse(raw));
  } catch {
    return [];
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function dateMs(value?: string): number {
  if (!value) return 0;
  const ms = +new Date(value);
  return Number.isFinite(ms) ? ms : 0;
}

function lastPathSegment(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
