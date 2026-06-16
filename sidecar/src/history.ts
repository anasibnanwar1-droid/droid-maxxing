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
import type {
  AgentRole,
  Autonomy,
  BridgeFeature,
  FeatureStatus,
  FactoryDefaultSettings,
  HistoryMission,
  MissionPhase,
  MissionSummary,
  ProgressEntry,
  ReasoningEffort,
  TranscriptEvent,
  WorkerHistoryLink,
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
  // (Task tool subagents). Such sessions are not standalone conversations.
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

export interface HistoricalMission {
  summary: MissionSummary;
  progress: ProgressEntry[];
}

export interface HistoricalSummaryFilter {
  workspaceCwds?: string[];
  includePlainChats?: boolean;
  limitPerWorkspace?: number;
}

export interface HydratedMissionHistory {
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

const STATE_TO_PHASE: Record<string, MissionPhase> = {
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
const MAX_WORKER_EVENTS = 3_000;
// How many orchestrator scrollback events to load per page (initial open and
// each lazy older-page fetch). Bounds work for very long, multi-compaction chats.
const DEFAULT_HISTORY_WINDOW = 400;
const MAX_SESSION_BYTES = 5_000_000;
const SESSION_START_BYTES = 256_000;

export function loadHistoricalMissions(options: HistoricalSummaryFilter = {}): HistoricalMission[] {
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
    .map((dir) => loadHistoricalMission(dir))
    .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt);
  return limitHistoricalRows(
    rows,
    workspaceCwds,
    options.limitPerWorkspace,
    options.includePlainChats,
  );
}

export function loadHistoricalSessions(options: HistoricalSummaryFilter = {}): HistoricalMission[] {
  const rows: HistoricalMission[] = [];
  const cached = readStoredSummaryPatches();
  const linkedWorkerIds = readLinkedWorkerSessionIds();
  const workspaceCwds = options.workspaceCwds
    ? new Set(options.workspaceCwds.filter(Boolean))
    : null;
  if (workspaceCwds && workspaceCwds.size === 0 && !options.includePlainChats) return [];
  for (const [sessionId, path] of buildSessionIndex()) {
    const start = readSessionStart(path);
    const classification = classifyStoredSession(start, linkedWorkerIds.has(sessionId));
    if (!classification) continue;
    const stat = statSync(path);
    const title = start.sessionTitle || start.title || `Session ${sessionId.slice(0, 8)}`;
    const settings = readSessionModelSettings(start, path);
    const summary = applyCachedSummary(
      {
        id: sessionId,
        sessionId,
        missionId: classification.missionId,
        parentSessionId: classification.parentSessionId,
        kind: classification.kind,
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

export function loadSessionHistory(): HistoryMission[] {
  const rows: HistoryMission[] = [];
  for (const [sessionId, path] of buildSessionIndex()) {
    const start = readSessionStart(path);
    const stat = statSync(path);
    rows.push({
      sessionId,
      title: start.sessionTitle || start.title || `Session ${sessionId.slice(0, 8)}`,
      cwd: start.cwd,
      modifiedTime: stat.mtimeMs,
      createdTime: stat.birthtimeMs,
      messageCount: countSessionMessages(path),
    });
  }
  return rows.sort((a, b) => b.modifiedTime - a.modifiedTime);
}

export function loadSessionPage(
  sessionId: string,
  cursor?: string,
  limit = 200,
  missionId = sessionId,
): HistoryPage {
  const path = buildSessionIndex().get(sessionId);
  if (!path) throw new Error(`Session history not found for ${sessionId}`);
  // A transcript opened as its OWN standalone chat (missionId === sessionId, e.g.
  // an orphan Task subagent surfaced in the sidebar) must replay as orchestrator
  // so the main chat view renders it: the worker role keys events to the session
  // id and drops user prompts, which ChatView's main feed then filters out,
  // leaving the chat blank. Worker-role replay is only correct when the
  // transcript is loaded inside its parent mission (missionId !== sessionId),
  // where it is shown in the worker panel keyed to its own id.
  const role =
    missionId === sessionId ? 'orchestrator' : roleFromSessionStart(readSessionStart(path));
  const all = parseSessionTranscript(missionId, sessionId, path, role);
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
    this.db = new DatabaseSync(join(dir, 'index.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        app_session_id TEXT PRIMARY KEY,
        droid_session_id TEXT NOT NULL,
        previous_droid_session_ids TEXT NOT NULL DEFAULT '[]',
        compaction_count INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
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
        max_context_tokens INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        parent_session_id TEXT,
        mission_id TEXT,
        role TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        mission_id TEXT,
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
      CREATE TABLE IF NOT EXISTS subagent_links (
        mission_id TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        worker_session_id TEXT NOT NULL,
        label TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (mission_id, tool_use_id)
      );
      CREATE TABLE IF NOT EXISTS linked_worker_sessions (
        worker_session_id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        request_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        request_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
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
    `);
    this.ensureColumn('app_sessions', 'compaction_count', 'INTEGER NOT NULL DEFAULT 0');
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  syncSummaries(summaries: MissionSummary[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO app_sessions (
        app_session_id,
        droid_session_id,
        previous_droid_session_ids,
        compaction_count,
        kind,
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
        max_context_tokens
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_session_id) DO UPDATE SET
        droid_session_id = excluded.droid_session_id,
        previous_droid_session_ids = excluded.previous_droid_session_ids,
        compaction_count = excluded.compaction_count,
        kind = excluded.kind,
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
        max_context_tokens = excluded.max_context_tokens
    `);
    for (const summary of summaries) {
      stmt.run(
        summary.id,
        summary.sessionId ?? summary.id,
        JSON.stringify(summary.compactedFromSessionIds ?? []),
        summary.compactionCount ?? 0,
        summary.kind,
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
      );
    }
  }

  summaryPatches(): Map<string, Partial<MissionSummary>> {
    const rows = this.db.prepare('SELECT * FROM app_sessions').all() as Record<string, unknown>[];
    return summaryPatchesFromRows(rows);
  }

  hiddenDroidSessionIds(): Set<string> {
    const rows = this.db
      .prepare('SELECT app_session_id, previous_droid_session_ids FROM app_sessions')
      .all() as Record<string, unknown>[];
    const hidden = new Set<string>();
    for (const row of rows) {
      const appSessionId = stringValue(row.app_session_id);
      for (const droidSessionId of jsonStringArray(row.previous_droid_session_ids)) {
        if (droidSessionId && droidSessionId !== appSessionId) hidden.add(droidSessionId);
      }
    }
    return hidden;
  }

  recordEvent(event: TranscriptEvent): void {
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO events (id, session_id, mission_id, kind, ts)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(event.id, event.agentSessionId, event.missionId, event.kind, event.ts);
  }

  // Persist the exact spawn->worker mapping the moment a live subagent resolves,
  // so historical loads can rebuild precise links rather than pairing by order.
  recordSubagentLink(
    missionId: string,
    toolUseId: string,
    workerSessionId: string,
    label?: string,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT INTO subagent_links (mission_id, tool_use_id, worker_session_id, label, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mission_id, tool_use_id) DO UPDATE SET
        worker_session_id = excluded.worker_session_id,
        label = excluded.label,
        updated_at = excluded.updated_at
    `,
      )
      .run(missionId, toolUseId, workerSessionId, sqlValue(label), now);
    // Remember every worker session ever linked to a spawn. A rekey (worker
    // compaction) repoints subagent_links at the new id, dropping the old id
    // from the current mapping; this append-only set keeps superseded worker
    // sessions hidden so they never resurface as standalone history chats.
    this.db
      .prepare(
        `
      INSERT INTO linked_worker_sessions (worker_session_id, updated_at)
      VALUES (?, ?)
      ON CONFLICT(worker_session_id) DO UPDATE SET updated_at = excluded.updated_at
    `,
      )
      .run(workerSessionId, now);
  }

  subagentLinks(missionId: string): WorkerHistoryLink[] {
    const rows = this.db
      .prepare(
        'SELECT tool_use_id, worker_session_id, label FROM subagent_links WHERE mission_id = ? ORDER BY updated_at ASC',
      )
      .all(missionId) as Record<string, unknown>[];
    return rows
      .map((row) => ({
        workerSessionId: stringValue(row.worker_session_id) ?? '',
        toolUseId: stringValue(row.tool_use_id),
        label: stringValue(row.label),
      }))
      .filter((link) => link.workerSessionId);
  }

  close(): void {
    this.db.close();
  }
}

// The set of worker session ids that have a persisted spawn->worker link. A
// Task subagent with a link is openable from its parent chat, so it is hidden
// from the standalone session list; one without a link (e.g. recorded before
// links were persisted) would otherwise be orphaned, so it stays visible.
// Unions the current mapping (subagent_links) with the append-only history of
// every linked worker id (linked_worker_sessions) so a worker that was rekeyed
// by compaction stays hidden under its superseded id too.
function readLinkedWorkerSessionIds(): Set<string> {
  const path = join(homedir(), '.factory', 'droid-control', 'index.sqlite');
  if (!existsSync(path)) return new Set();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch {
    return new Set();
  }
  const ids = new Set<string>();
  const collect = (sql: string) => {
    try {
      for (const row of db.prepare(sql).all() as Record<string, unknown>[]) {
        const id = stringValue(row.worker_session_id);
        if (id) ids.add(id);
      }
    } catch {
      /* table may not exist on older databases; ignore */
    }
  };
  try {
    collect('SELECT DISTINCT worker_session_id FROM subagent_links');
    collect('SELECT worker_session_id FROM linked_worker_sessions');
    return ids;
  } finally {
    db.close();
  }
}

function readStoredSummaryPatches(): Map<string, Partial<MissionSummary>> {
  const path = join(homedir(), '.factory', 'droid-control', 'index.sqlite');
  if (!existsSync(path)) return new Map();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch {
    return new Map();
  }
  try {
    const rows = db.prepare('SELECT * FROM app_sessions').all() as Record<string, unknown>[];
    return summaryPatchesFromRows(rows);
  } catch {
    return new Map();
  } finally {
    db.close();
  }
}

function summaryPatchesFromRows(
  rows: Record<string, unknown>[],
): Map<string, Partial<MissionSummary>> {
  const patches = new Map<string, Partial<MissionSummary>>();
  for (const row of rows) {
    const appSessionId = stringValue(row.app_session_id);
    const droidSessionId = stringValue(row.droid_session_id);
    if (!appSessionId || !droidSessionId) continue;
    const patch: Partial<MissionSummary> = {
      id: appSessionId,
      sessionId: droidSessionId,
      compactedFromSessionIds: jsonStringArray(row.previous_droid_session_ids),
      compactionCount: numberValue(row.compaction_count),
      kind: sessionKind(stringValue(row.kind)),
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
      updatedAt: numberValue(row.updated_at),
    };
    patches.set(appSessionId, patch);
    patches.set(droidSessionId, patch);
  }
  return patches;
}

export function applyCachedSummary(
  summary: MissionSummary,
  cached: Map<string, Partial<MissionSummary>>,
): MissionSummary {
  const patch = cached.get(summary.sessionId ?? summary.id) ?? cached.get(summary.id);
  if (!patch) return summary;
  const defined = definedPatch(patch);
  return {
    ...summary,
    ...defined,
    id: defined.id ?? summary.id,
    sessionId: defined.sessionId ?? summary.sessionId,
    missionId: defined.missionId ?? summary.missionId,
    parentSessionId: defined.parentSessionId ?? summary.parentSessionId,
    kind: defined.kind ?? summary.kind,
    role: defined.role ?? summary.role,
  };
}

function definedPatch(patch: Partial<MissionSummary>): Partial<MissionSummary> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<MissionSummary>;
}

export function hydrateHistoricalMission(
  missionId: string,
  opts: { cursor?: string; limit?: number } = {},
): HydratedMissionHistory {
  const dir = resolveMissionDir(missionId);
  if (!dir) throw new Error(`Mission history not found for ${missionId}`);

  const { summary, progress, state, features } = loadHistoricalMission(dir);
  const sessionIndex = buildSessionIndex();

  // The orchestrator backing session is rekeyed on every compaction, so the
  // full conversation is spread across a CHAIN of session files. Resolve that
  // chain (oldest -> newest) from the persisted app-session row; replaying only
  // the latest segment is what made compacted chats lose their scrollback.
  const chain = orchestratorChain(summary, sessionIndex);
  const window = loadMissionTranscriptWindow(summary.id, chain, opts);

  // Older pages only extend the orchestrator scrollback upward; workers and
  // progress were already delivered with the initial (newest) page.
  if (opts.cursor) {
    return { progress: [], transcripts: window.events, olderCursor: window.olderCursor };
  }

  const agentRoles = buildAgentRoles(state, features, progress);
  const chainSet = new Set(chain);
  const workerEvents: TranscriptEvent[] = [];
  for (const [sessionId, role] of agentRoles) {
    if (chainSet.has(sessionId)) continue;
    const path = sessionIndex.get(sessionId);
    if (!path) continue;
    workerEvents.push(...parseSessionTranscript(summary.id, sessionId, path, role));
  }
  // The orchestrator scrollback is paged via the cursor; only the (bounded)
  // worker events need a safety cap so a worker-heavy mission stays responsive.
  const cappedWorkers =
    workerEvents.length > MAX_WORKER_EVENTS
      ? workerEvents.slice(workerEvents.length - MAX_WORKER_EVENTS)
      : workerEvents;

  const transcripts = [...window.events, ...cappedWorkers].sort((a, b) => a.ts - b.ts);
  return { progress, transcripts, olderCursor: window.olderCursor };
}

// Resolve the orchestrator's compaction chain (oldest -> newest backing session
// ids) for a mission. The persisted app-session row keeps the authoritative
// chain (previous backing ids + current); fall back to the summary when it is
// already hydrated with one. Filtered to ids that still have a session file.
function orchestratorChain(summary: MissionSummary, sessionIndex: Map<string, string>): string[] {
  const patches = readStoredSummaryPatches();
  const patch = patches.get(summary.id) ?? patches.get(summary.sessionId ?? summary.id);
  const currentSession = patch?.sessionId ?? summary.sessionId ?? summary.id;
  const compactedFrom = patch?.compactedFromSessionIds ?? summary.compactedFromSessionIds ?? [];
  return dedupeStrings([summary.id, ...compactedFrom, currentSession]).filter((id) =>
    sessionIndex.has(id),
  );
}

// Resolve the compaction chain (oldest -> newest backing session ids) for a
// plain chat / spec session that has NO mission directory. Such sessions never
// reach hydrateHistoricalMission, so without this they would replay only the
// newest backing file and lose all pre-compaction scrollback. Reads the chain
// straight from the persisted app-session row (keyed by either id) and filters
// to ids that still have a session file on disk.
export function resolveSessionChain(appSessionId: string, droidSessionId: string): string[] {
  const sessionIndex = buildSessionIndex();
  const patches = readStoredSummaryPatches();
  const patch = patches.get(appSessionId) ?? patches.get(droidSessionId);
  const currentSession = patch?.sessionId ?? droidSessionId;
  const compactedFrom = patch?.compactedFromSessionIds ?? [];
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
  missionId: string,
  sessionId: string,
  comp: CompactionState,
): TranscriptEvent {
  return {
    id: `${sessionId}:compaction`,
    missionId,
    agentSessionId: 'orchestrator',
    role: 'orchestrator',
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
function segmentItems(missionId: string, sessionId: string, path: string): TranscriptEvent[] {
  const items: TranscriptEvent[] = [];
  const comp = readCompactionState(path);
  if (comp) items.push(compactionDividerEvent(missionId, sessionId, comp));
  items.push(...parseSessionTranscript(missionId, sessionId, path, 'orchestrator'));
  return items;
}

// Window the orchestrator transcript backward across the compaction chain.
// Reads files newest -> oldest only as far as needed to fill `limit`, so a
// months-long, heavily-compacted chat opens fast and pages older history in on
// demand. The cursor is "<chainIdx>:<itemEnd>" ('end' = the file's tail).
export function loadMissionTranscriptWindow(
  missionId: string,
  chainSessionIds: string[],
  opts: { cursor?: string; limit?: number } = {},
): { events: TranscriptEvent[]; olderCursor?: string } {
  const limit = Math.max(1, opts.limit ?? DEFAULT_HISTORY_WINDOW);
  const sessionIndex = buildSessionIndex();
  const chain = chainSessionIds.filter((id) => sessionIndex.has(id));
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
    const items = segmentItems(missionId, chain[ci], path);
    let start = ci === startIdx ? Math.min(end, items.length) : items.length;
    while (start > 0 && picked.length < limit) {
      start--;
      picked.push(items[start]);
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
  const mission = objectValue(settings.missionModelSettings) ?? {};
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
    workerModelId: stringValue(mission.workerModel),
    workerReasoningEffort: mapReasoning(stringValue(mission.workerReasoningEffort)),
    validatorModelId: stringValue(mission.validationWorkerModel),
    validatorReasoningEffort: mapReasoning(stringValue(mission.validationWorkerReasoningEffort)),
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

function loadHistoricalMission(dir: string): HistoricalMission & {
  state: StoredMissionState;
  features: BridgeFeature[];
} {
  const state = readJson<StoredMissionState>(join(dir, 'state.json'));
  const progress = readProgress(join(dir, 'progress_log.jsonl'));
  const features = readFeatures(join(dir, 'features.json'));
  const dirId = basename(dir);
  const sessionId = state.baseSessionId || dirId;
  const firstProgressTitle = progress.find((p) => p.title)?.title;
  const cwd = state.workingDirectory || state.cwd || '';
  const title =
    firstProgressTitle ||
    state.missionId ||
    lastPathSegment(cwd) ||
    `Mission ${sessionId.slice(0, 8)}`;
  const createdAt =
    dateMs(state.createdAt) || dateMs(progress[0]?.timestamp) || statSync(dir).birthtimeMs;
  const updatedAt =
    dateMs(state.updatedAt) ||
    dateMs(progress[progress.length - 1]?.timestamp) ||
    statSync(dir).mtimeMs;
  const modelSettings = readMissionModelSettings(dir);

  return {
    summary: {
      id: sessionId,
      sessionId,
      missionId: state.missionId ?? dirId,
      kind: 'mission_orchestrator',
      role: 'orchestrator',
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

function readProgress(path: string): ProgressEntry[] {
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
      workerSessionId: stringValue(entry.workerSessionId),
    };
  });
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
      workerSessionIds: stringArray(f.workerSessionIds),
      currentWorkerSessionId: stringValue(f.currentWorkerSessionId) ?? null,
      completedWorkerSessionId: stringValue(f.completedWorkerSessionId) ?? null,
    };
  }
}

function parseSessionTranscript(
  missionId: string,
  sessionId: string,
  path: string,
  role: AgentRole,
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const sessionLines = readSessionJsonLines<StoredMessageLine | StoredSessionStart>(path);
  if (sessionLines.trimmed) {
    events.push(
      event(missionId, sessionId, role, 'history-window', 0, statSync(path).mtimeMs, 'status', {
        text: `Loaded latest ${Math.round(MAX_SESSION_BYTES / 1_000_000)} MB of this oversized session for UI performance.`,
      }),
    );
  }
  for (const line of sessionLines.rows) {
    if (line.type !== 'message' || !('message' in line)) continue;
    const message = line.message;
    const content = Array.isArray(message?.content) ? message.content : [];
    const ts = dateMs(line.timestamp) || Date.now();
    const messageId = line.id || `${sessionId}-${ts}`;
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
              event(missionId, sessionId, role, messageId, index, ts, 'thinking', { text }),
            );
        } else if (type === 'text') {
          const text = trimText(stringValue(block.text) || '');
          if (text)
            events.push(event(missionId, sessionId, role, messageId, index, ts, 'text', { text }));
        } else if (type === 'tool_use') {
          events.push(
            event(missionId, sessionId, role, messageId, index, ts, 'tool_call', {
              toolName: stringValue(block.name) || 'tool',
              toolArgs: block.input,
              // Carry the tool_use id so persisted subagent links resolve exactly
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
          event(missionId, sessionId, role, messageId, index, ts, 'tool_result', {
            toolName: stringValue(block.name),
            text: trimText(contentText),
            isError: Boolean(block.is_error ?? block.isError),
            // Carry the originating call's id so the renderer can correlate a
            // result to its tool_call exactly (result blocks have no name and
            // may not be adjacent to their call after replay/batching).
            toolUseId: stringValue(block.tool_use_id ?? block.toolUseId) || undefined,
          }),
        );
      } else if (messageRole === 'user' && role === 'orchestrator' && type === 'text') {
        const rawText = trimText(stringValue(block.text) || '');
        const display = designPromptDisplayFromText(rawText);
        const text = display?.text ?? rawText;
        if (text && !isSystemText(text)) {
          events.push(
            event(missionId, 'user', 'orchestrator', messageId, index, ts, 'text', {
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
  missionId: string,
  sessionId: string,
  role: AgentRole,
  messageId: string,
  index: number,
  ts: number,
  kind: TranscriptEvent['kind'],
  extra: Partial<TranscriptEvent>,
): TranscriptEvent {
  return {
    id: `${sessionId}:${messageId}:${index}:${kind}`,
    missionId,
    agentSessionId: role === 'orchestrator' && sessionId !== 'user' ? 'orchestrator' : sessionId,
    role,
    ts,
    kind,
    ...extra,
  };
}

function buildAgentRoles(
  state: StoredMissionState,
  features: BridgeFeature[],
  progress: ProgressEntry[],
): Map<string, AgentRole> {
  const roles = new Map<string, AgentRole>();
  const stateWorkers = state.workerSessionIds ?? [];
  stateWorkers.forEach((id) => roles.set(id, 'worker'));

  features.forEach((feature) => {
    const role = isValidatorFeature(feature) ? 'validator' : 'worker';
    for (const id of featureWorkerIds(feature)) roles.set(id, role);
  });

  progress.forEach((entry) => {
    if (entry.workerSessionId && !roles.has(entry.workerSessionId))
      roles.set(entry.workerSessionId, 'worker');
  });

  return roles;
}

function featureWorkerIds(feature: BridgeFeature): string[] {
  return [
    ...(feature.workerSessionIds ?? []),
    feature.currentWorkerSessionId,
    feature.completedWorkerSessionId,
  ].filter(Boolean) as string[];
}

function isValidatorFeature(feature: BridgeFeature): boolean {
  const text = `${feature.id} ${feature.skillName} ${feature.description}`.toLowerCase();
  return text.includes('validator') || text.includes('validation') || text.includes('scrutiny');
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
  rows: HistoricalMission[],
  workspaceCwds: Set<string> | null,
  limitPerWorkspace?: number,
  includePlainChats?: boolean,
): HistoricalMission[] {
  if (!workspaceCwds && !includePlainChats) return rows;
  // An omitted limit means "no cap" so the sidebar can load every persisted
  // session and reveal the older ones behind "Show more".
  const limit =
    limitPerWorkspace === undefined ? undefined : Math.max(1, Math.min(limitPerWorkspace, 50));
  const cap = <T>(items: T[]): T[] => (limit === undefined ? items : items.slice(0, limit));
  const limited: HistoricalMission[] = [];
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
    readSync(fd, buffer, 0, bytes, 0);
    const row = parseJsonLines<StoredSessionStart>(buffer.toString('utf8')).find(
      (line) => line.type === 'session_start',
    );
    return row ?? {};
  } finally {
    closeSync(fd);
  }
}

function classifyStoredSession(
  start: StoredSessionStart,
  hasPersistedLink: boolean,
): Pick<MissionSummary, 'kind' | 'role' | 'missionId' | 'parentSessionId'> | null {
  if (start.decompSessionType === 'worker') return null;
  if (start.decompSessionType === 'validator') return null;
  // Task-tool subagents run as their own droid sessions but are spawned by a
  // parent session's tool call. Hide one only when a persisted spawn->worker
  // link lets the parent chat open it as a worker; without a link (e.g. sessions
  // recorded before links were persisted) it would be orphaned, so keep it
  // visible as a standalone session. Gate on the spawn markers only: a bare
  // `parent` link is also set on ordinary forked chats, which ARE standalone
  // conversations and must stay visible in history.
  if ((start.callingSessionId || start.callingToolUseId) && hasPersistedLink) return null;
  const mode = sessionInteractionMode(start);
  const missionId = start.decompMissionId;
  if (start.decompSessionType === 'orchestrator' || missionId || mode === 'agi') {
    return {
      kind: 'mission_orchestrator',
      role: 'orchestrator',
      missionId,
      parentSessionId: undefined,
    };
  }
  if (mode === 'spec')
    return { kind: 'spec', role: 'orchestrator', missionId: undefined, parentSessionId: undefined };
  return { kind: 'chat', role: 'orchestrator', missionId: undefined, parentSessionId: undefined };
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

function contextAccuracy(value: unknown): MissionSummary['contextAccuracy'] | undefined {
  if (value === 'exact' || value === 'estimated') return value;
  return undefined;
}

function sessionKind(value?: string): MissionSummary['kind'] | undefined {
  if (
    value === 'chat' ||
    value === 'spec' ||
    value === 'mission_orchestrator' ||
    value === 'mission_worker' ||
    value === 'mission_validator'
  ) {
    return value;
  }
  return undefined;
}

function workspaceKind(value?: string): MissionSummary['workspaceKind'] | undefined {
  if (value === 'folder' || value === 'none') return value;
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sqlValue(value: string | number | undefined): string | number | null {
  return value ?? null;
}

function roleFromSessionStart(start: StoredSessionStart): AgentRole {
  if (start.decompSessionType === 'validator') return 'validator';
  if (start.decompSessionType === 'worker') return 'worker';
  // Task-tool subagents carry no decompSessionType but are spawned by a parent
  // session's tool call (callingSessionId/callingToolUseId). Replay them as
  // workers so their transcript keys to their own session id instead of being
  // folded into 'orchestrator' (which would leave the opened subagent blank).
  if (start.callingSessionId || start.callingToolUseId) return 'worker';
  return 'orchestrator';
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
