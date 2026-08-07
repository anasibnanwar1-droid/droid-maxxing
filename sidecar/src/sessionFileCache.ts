/**
 * Session file cache: a sqlite-backed index of the session files under
 * ~/.factory/sessions, so serving the historical session list does not walk
 * and re-read every file on each request.
 *
 * The cache table is additive and outside the versioned history schema, so
 * existing installs gain it without a migration. HistoryIndex owns the
 * database handle and passes the scan/summarize primitives in, keeping this
 * module free of imports from history.ts.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SessionSummary } from './protocol.js';
import { numberValue, stringValue } from './values.js';

export interface SessionFileStat {
  path: string;
  birthtimeMs: number;
  mtimeMs: number;
  sizeBytes: number;
  // Mtime of the sibling <id>.settings.json the summary also reads, null when
  // no settings file exists. Part of the reconcile freshness key.
  settingsMtimeMs: number | null;
}

export interface SessionFileScan {
  files: Map<string, SessionFileStat>;
  // False when any subtree vanished or became unreadable during the walk.
  // Upserts are still authoritative, but absences cannot prove deletion.
  isComplete: boolean;
}

interface CachedSessionFile extends SessionFileStat {
  providerSessionId: string;
  // Null marks a file that was scanned and classified as worker/validator/
  // Task-child history, so reconciles skip it without re-reading its head.
  summary: SessionSummary | null;
}

const UPSERT_SESSION_FILE = `
  INSERT INTO session_file_cache (
    provider_session_id, path, birthtime_ms, mtime_ms, size_bytes, settings_mtime_ms, summary_json
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(provider_session_id) DO UPDATE SET
    path = excluded.path,
    birthtime_ms = excluded.birthtime_ms,
    mtime_ms = excluded.mtime_ms,
    size_bytes = excluded.size_bytes,
    settings_mtime_ms = excluded.settings_mtime_ms,
    summary_json = excluded.summary_json
`;
const REMOVE_SESSION_FILE = 'DELETE FROM session_file_cache WHERE provider_session_id = ?';

// The freshness key: a cached row is current while the session file and its
// settings sidecar have the same mtime/size as when it was summarized.
function matchesFreshnessKey(cached: CachedSessionFile, file: SessionFileStat): boolean {
  return (
    cached.path === file.path &&
    cached.mtimeMs === file.mtimeMs &&
    cached.sizeBytes === file.sizeBytes &&
    cached.settingsMtimeMs === file.settingsMtimeMs
  );
}

// Returns the cached summary, null for a known non-top-level file, or
// undefined when the stored JSON does not hold a summary shape and the row
// must be rebuilt.
function parseCachedSessionSummary(raw: unknown): SessionSummary | null | undefined {
  const text = stringValue(raw);
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const summary = parsed as SessionSummary;
    if (typeof summary.cwd !== 'string') return undefined;
    return summary;
  } catch {
    return undefined;
  }
}

export class SessionFileCache {
  private readonly files = new Map<string, CachedSessionFile>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly scanFiles: () => SessionFileScan,
    private readonly summarizeFile: (
      providerSessionId: string,
      file: SessionFileStat,
    ) => SessionSummary | null,
    // Stats one session file and its settings sidecar; null when the file is
    // gone. Used by the targeted reconcile so watcher events do not trigger
    // a full sessions-tree walk.
    private readonly statFile: (path: string) => SessionFileStat | null,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_file_cache (
        provider_session_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        birthtime_ms REAL NOT NULL,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        settings_mtime_ms REAL,
        summary_json TEXT
      )
    `);
    // Tables created before the settings sidecar joined the freshness key
    // gain the column here; their rows keep NULL until the next reconcile,
    // which re-summarizes files that have a settings sidecar exactly once.
    const columns = db
      .prepare('PRAGMA table_info(session_file_cache)')
      .all()
      .map((row) => stringValue((row as Record<string, unknown>).name));
    if (!columns.includes('settings_mtime_ms')) {
      db.exec('ALTER TABLE session_file_cache ADD COLUMN settings_mtime_ms REAL');
    }
    this.loadRows();
  }

  get size(): number {
    return this.files.size;
  }

  // Base summaries of every cached top-level session file, as of the last
  // reconcile. Callers apply the app_sessions patch overlay and filtering.
  summaries(): SessionSummary[] {
    const rows: SessionSummary[] = [];
    for (const entry of this.files.values()) {
      if (entry.summary) rows.push(entry.summary);
    }
    return rows;
  }

  // Path, stat, and base summary for every cached top-level session file, so
  // transcript content search can open the files without re-walking the
  // sessions tree. Callers apply the app_sessions patch overlay.
  searchableEntries(): {
    providerSessionId: string;
    path: string;
    mtimeMs: number;
    sizeBytes: number;
    summary: SessionSummary;
  }[] {
    const rows: {
      providerSessionId: string;
      path: string;
      mtimeMs: number;
      sizeBytes: number;
      summary: SessionSummary;
    }[] = [];
    for (const entry of this.files.values()) {
      if (entry.summary) {
        rows.push({
          providerSessionId: entry.providerSessionId,
          path: entry.path,
          mtimeMs: entry.mtimeMs,
          sizeBytes: entry.sizeBytes,
          summary: entry.summary,
        });
      }
    }
    return rows;
  }

  // Diff cached session files against the files on disk, re-summarizing only
  // new or changed files and dropping deleted ones. A file that vanishes or
  // breaks mid-reconcile is skipped and retried on the next reconcile, so
  // one bad file cannot abort the whole diff. Returns the number of cache
  // entries written or removed.
  reconcile(): number {
    const { files: onDisk, isComplete } = this.scanFiles();
    let changed = 0;
    const upsert = this.db.prepare(UPSERT_SESSION_FILE);
    const remove = this.db.prepare(REMOVE_SESSION_FILE);
    // A partial scan cannot distinguish a deleted file from a temporarily
    // unreadable subtree. Preserve unmatched rows until a complete scan can
    // authoritatively remove them.
    if (isComplete) {
      for (const id of [...this.files.keys()]) {
        if (!onDisk.has(id)) {
          remove.run(id);
          this.files.delete(id);
          changed += 1;
        }
      }
    }
    for (const [id, file] of onDisk) {
      const cached = this.files.get(id);
      if (cached && matchesFreshnessKey(cached, file)) continue;
      try {
        const summary = this.summarizeFile(id, file);
        // Persist before mutating the in-memory cache so a SQLite write
        // failure cannot leave the cache holding a row the database never
        // got: the cache must mirror the database across the process life.
        upsert.run(
          id,
          file.path,
          file.birthtimeMs,
          file.mtimeMs,
          file.sizeBytes,
          file.settingsMtimeMs,
          summary === null ? null : JSON.stringify(summary),
        );
        this.files.set(id, { providerSessionId: id, ...file, summary });
        changed += 1;
      } catch {
        // The file was deleted or rotated between the scan and the read;
        // the next watcher event or boot reconcile retries it.
      }
    }
    return changed;
  }

  // Reconcile exactly the session files a watcher event reported, so live
  // external changes cost a stat (and at most one re-parse) per changed file
  // instead of a walk of the whole sessions tree. A reported file that no
  // longer exists is dropped from the cache; a file that vanished or broke
  // mid-reconcile is skipped and retried on the next event. Returns the
  // number of cache entries written or removed.
  reconcilePaths(changes: { providerSessionId: string; path: string }[]): number {
    let changed = 0;
    const upsert = this.db.prepare(UPSERT_SESSION_FILE);
    const remove = this.db.prepare(REMOVE_SESSION_FILE);
    for (const { providerSessionId, path } of changes) {
      const file = this.statFile(path);
      if (!file) {
        if (this.files.has(providerSessionId)) {
          remove.run(providerSessionId);
          this.files.delete(providerSessionId);
          changed += 1;
        }
        continue;
      }
      const cached = this.files.get(providerSessionId);
      if (cached && matchesFreshnessKey(cached, file)) continue;
      try {
        const summary = this.summarizeFile(providerSessionId, file);
        // Persist before mutating the in-memory cache (see reconcile()).
        upsert.run(
          providerSessionId,
          file.path,
          file.birthtimeMs,
          file.mtimeMs,
          file.sizeBytes,
          file.settingsMtimeMs,
          summary === null ? null : JSON.stringify(summary),
        );
        this.files.set(providerSessionId, { providerSessionId, ...file, summary });
        changed += 1;
      } catch {
        // The file was deleted or rotated between the stat and the read;
        // the next watcher event or boot reconcile retries it.
      }
    }
    return changed;
  }

  private loadRows(): void {
    const rows: unknown[] = this.db
      .prepare(
        `SELECT provider_session_id, path, birthtime_ms, mtime_ms, size_bytes, settings_mtime_ms, summary_json
         FROM session_file_cache`,
      )
      .all();
    const removeCorrupt = this.db.prepare(
      'DELETE FROM session_file_cache WHERE provider_session_id = ?',
    );
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const record = row as Record<string, unknown>;
      const id = stringValue(record.provider_session_id);
      const path = stringValue(record.path);
      if (!id || !path) continue;
      const summary = parseCachedSessionSummary(record.summary_json);
      if (summary === undefined) {
        // An unparseable row is dropped so the next reconcile rebuilds it.
        removeCorrupt.run(id);
        continue;
      }
      this.files.set(id, {
        providerSessionId: id,
        path,
        birthtimeMs: numberValue(record.birthtime_ms) ?? 0,
        mtimeMs: numberValue(record.mtime_ms) ?? 0,
        sizeBytes: numberValue(record.size_bytes) ?? 0,
        settingsMtimeMs: numberValue(record.settings_mtime_ms) ?? null,
        summary,
      });
    }
  }
}
