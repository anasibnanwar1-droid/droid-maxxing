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
}

interface CachedSessionFile extends SessionFileStat {
  providerSessionId: string;
  // Null marks a file that was scanned and classified as worker/validator/
  // Task-child history, so reconciles skip it without re-reading its head.
  summary: SessionSummary | null;
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
    private readonly scanFiles: () => Map<string, SessionFileStat>,
    private readonly summarizeFile: (
      providerSessionId: string,
      file: SessionFileStat,
    ) => SessionSummary | null,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_file_cache (
        provider_session_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        birthtime_ms REAL NOT NULL,
        mtime_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        summary_json TEXT
      )
    `);
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

  // Diff cached session files against the files on disk, re-summarizing only
  // new or changed files and dropping deleted ones. Returns the number of
  // cache entries written or removed.
  reconcile(): number {
    const onDisk = this.scanFiles();
    let changed = 0;
    const upsert = this.db.prepare(`
      INSERT INTO session_file_cache (
        provider_session_id, path, birthtime_ms, mtime_ms, size_bytes, summary_json
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_session_id) DO UPDATE SET
        path = excluded.path,
        birthtime_ms = excluded.birthtime_ms,
        mtime_ms = excluded.mtime_ms,
        size_bytes = excluded.size_bytes,
        summary_json = excluded.summary_json
    `);
    const remove = this.db.prepare('DELETE FROM session_file_cache WHERE provider_session_id = ?');
    for (const id of [...this.files.keys()]) {
      if (!onDisk.has(id)) {
        this.files.delete(id);
        remove.run(id);
        changed += 1;
      }
    }
    for (const [id, file] of onDisk) {
      const cached = this.files.get(id);
      if (
        cached?.path === file.path &&
        cached.mtimeMs === file.mtimeMs &&
        cached.sizeBytes === file.sizeBytes
      )
        continue;
      const summary = this.summarizeFile(id, file);
      this.files.set(id, { providerSessionId: id, ...file, summary });
      upsert.run(
        id,
        file.path,
        file.birthtimeMs,
        file.mtimeMs,
        file.sizeBytes,
        summary === null ? null : JSON.stringify(summary),
      );
      changed += 1;
    }
    return changed;
  }

  private loadRows(): void {
    const rows: unknown[] = this.db
      .prepare(
        `SELECT provider_session_id, path, birthtime_ms, mtime_ms, size_bytes, summary_json
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
        summary,
      });
    }
  }
}
