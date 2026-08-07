// Lazy session transcript reader.
//
// Opening a session must not parse a multi-MB JSONL file upfront: the reader
// holds the (tail-windowed) raw lines and JSON.parses them backward, newest
// first, only as far as each requested window needs. Paging older history
// parses a few hundred more lines per page instead of re-reading the whole
// file, and the per-line parse memo makes repeat pages and reopens free.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { open as openAsync, readFile as readFileAsync } from 'node:fs/promises';
import { dateMs, numberValue, objectValue, stringValue } from './values.js';
import {
  event,
  parseSessionLineEvents,
  type StoredMessageLine,
  type StoredSessionStart,
} from './sessionTranscriptParser.js';
import type { SessionRole, TranscriptEvent } from './protocol.js';

// Stored-row shapes are owned by the parser module but re-exported here so
// the history path's import stays stable.
export type { StoredMessageLine, StoredSessionStart } from './sessionTranscriptParser.js';

// Oversized session files are tail-windowed to the newest bytes; the dropped
// head is surfaced as a status event when paging reaches the top.
export const MAX_SESSION_BYTES = 5_000_000;
// The session_start / leading compaction_state records live at the head of the
// file; readers cap that head read instead of scanning the whole file.
export const SESSION_START_BYTES = 256_000;
// seq band per line: a line yields one event per content block, so (line,
// event-in-line) maps to a unique, stable, monotonically increasing seq
// within a segment. 256 far exceeds any real message's block count; a freak
// line with more blocks clamps onto the last band slot (order within that
// line is then kept by array order, not seq).
const LINE_EVENT_STRIDE = 256;

interface CompactionState {
  removedCount?: number;
  ts: number;
}

// A position inside one segment's event stream: the next line to parse
// walking backward, plus how many of that line's tail events were already
// served (a page boundary can split one line's events across pages).
// line -1 addresses the synthesized head events (oversized-trim status and
// the head compaction divider), which sort before every parsed line.
export interface TranscriptWindowCursor {
  line: number;
  skip: number;
}

// Read the bytes a transcript parse can see: the whole file, or the newest
// MAX_SESSION_BYTES tail for oversized files (the partial first line of the
// window is dropped).
export function readSessionRawWindow(
  path: string,
  size: number,
): { text: string; trimmed: boolean } {
  if (size <= MAX_SESSION_BYTES) return { text: readFileSync(path, 'utf8'), trimmed: false };
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_SESSION_BYTES);
    readSync(fd, buffer, 0, MAX_SESSION_BYTES, size - MAX_SESSION_BYTES);
    const raw = buffer.toString('utf8');
    const firstNewline = raw.indexOf('\n');
    return {
      text: firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw,
      trimmed: true,
    };
  } finally {
    closeSync(fd);
  }
}

// Async twin of readSessionRawWindow for callers that must not block the
// event loop (transcript content search answers bridge commands inline).
export async function readSessionRawWindowAsync(
  path: string,
  size: number,
): Promise<{ text: string; trimmed: boolean }> {
  if (size <= MAX_SESSION_BYTES) {
    return { text: await readFileAsync(path, 'utf8'), trimmed: false };
  }
  const handle = await openAsync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_SESSION_BYTES);
    await handle.read(buffer, 0, MAX_SESSION_BYTES, size - MAX_SESSION_BYTES);
    const raw = buffer.toString('utf8');
    const firstNewline = raw.indexOf('\n');
    return {
      text: firstNewline >= 0 ? raw.slice(firstNewline + 1) : raw,
      trimmed: true,
    };
  } finally {
    await handle.close();
  }
}

// Reads from the HEAD of the file (compaction_state is a leading record); the
// transcript reader tail-windows oversized files and would miss it.
function readCompactionState(path: string): CompactionState | null {
  const size = statSync(path).size;
  const bytes = Math.min(size, SESSION_START_BYTES);
  const fd = openSync(path, 'r');
  let rows: unknown[];
  try {
    const buffer = Buffer.alloc(bytes);
    readSync(fd, buffer, 0, bytes, 0);
    rows = parseJsonLines(buffer.toString('utf8'));
  } finally {
    closeSync(fd);
  }
  for (const row of rows) {
    // Tolerate syntactically valid non-object JSONL rows (null, numbers,
    // booleans, arrays): they are noise, not a leading record, so a stray
    // literal must not crash the head read by dereferencing null.
    const obj = objectValue(row);
    if (!obj) continue;
    if (obj.type === 'session_start') continue;
    if (obj.type === 'compaction_state') {
      return {
        removedCount: numberValue(obj.removedCount),
        ts: dateMs(stringValue(obj.timestamp)) || 0,
      };
    }
    return null;
  }
  return null;
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

// Full eager parse of one session file, including the oversized-trim status
// head. Used by the provider-scoped history.page path, which slices a
// materialized event array by item index and so cannot window lazily.
export function parseFullSessionTranscript(
  appSessionId: string,
  providerSessionId: string,
  path: string,
  role: SessionRole,
): TranscriptEvent[] {
  const stat = statSync(path);
  const window = readSessionRawWindow(path, stat.size);
  const events: TranscriptEvent[] = [];
  if (window.trimmed) {
    events.push(oversizedStatusEvent(appSessionId, providerSessionId, role, stat.mtimeMs));
  }
  for (const raw of window.text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      events.push(
        ...parseSessionLineEvents(
          appSessionId,
          providerSessionId,
          role,
          JSON.parse(trimmed) as StoredMessageLine | StoredSessionStart,
        ),
      );
    } catch {
      /* skip partial/corrupt JSONL rows */
    }
  }
  return events;
}

// One chain segment's transcript, parsed lazily from the tail. Lines are
// JSON.parsed at most once each (memoized per line index); windows walk
// backward from a cursor, so the first page of a huge session parses a few
// hundred lines instead of the whole file.
export class SessionTranscriptReader {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  private readonly lines: string[];
  private readonly trimmed: boolean;
  private readonly headCompaction: CompactionState | null;
  private readonly parsedLines = new Map<number, TranscriptEvent[]>();
  private readonly compactionTimestamps = new Set<number>();
  private headEvents: TranscriptEvent[] | null = null;

  constructor(
    private readonly appSessionId: string,
    private readonly providerSessionId: string,
    path: string,
    private readonly role: SessionRole,
  ) {
    const stat = statSync(path);
    this.mtimeMs = stat.mtimeMs;
    this.sizeBytes = stat.size;
    const window = readSessionRawWindow(path, stat.size);
    this.lines = window.text.split(/\r?\n/).filter((line) => line.trim());
    this.trimmed = window.trimmed;
    this.headCompaction = readCompactionState(path);
  }

  // Serve up to `limit` events ending at `from` (or the segment tail),
  // walking backward. Returned events are in forward (chronological) order
  // with seq = seqBase + segment-local position. `older` is set when the
  // segment still has unserved events below the returned page.
  windowBackward(
    limit: number,
    seqBase: number,
    from?: TranscriptWindowCursor,
  ): { events: TranscriptEvent[]; older?: TranscriptWindowCursor } {
    if (from && from.line < 0) {
      const head = this.headEventsAtExhaustion().map((e) => ({
        ...e,
        seq: seqBase + (e.seq ?? 0),
      }));
      return { events: head };
    }
    const { collected, older, exhausted } = this.collectBackward(limit, from);
    let finalOlder = older;
    if (!finalOlder && exhausted) {
      // Every line is parsed at this point, so the head events are final.
      // Serve them atomically: a page may overshoot the limit by one event,
      // which the renderer tolerates, rather than splitting a two-event head.
      const head = this.headEventsAtExhaustion();
      if (head.length > 0 && limit - collected.length < head.length) {
        finalOlder = { line: -1, skip: 0 };
      } else {
        // `collected` is newest-first and reversed before returning, so the
        // forward-ordered head events go on in reverse to land at the top.
        collected.push(...head.slice().reverse());
      }
    }
    collected.reverse();
    return {
      events: collected.map((e) => ({ ...e, seq: seqBase + (e.seq ?? 0) })),
      ...(finalOlder ? { older: finalOlder } : {}),
    };
  }

  // Walk lines backward from `from` (or the tail), collecting up to `limit`
  // events newest-first. `older` addresses the first unserved event;
  // `exhausted` means every line was consumed (head events may remain).
  private collectBackward(
    limit: number,
    from?: TranscriptWindowCursor,
  ): { collected: TranscriptEvent[]; older?: TranscriptWindowCursor; exhausted: boolean } {
    const collected: TranscriptEvent[] = []; // newest first
    let line = from ? from.line : this.lines.length - 1;
    let skip = from?.skip ?? 0;
    while (line >= 0 && collected.length < limit) {
      const events = this.parseLine(line); // forward order within the line
      const available = events.length - skip;
      const take = Math.min(available, limit - collected.length);
      for (let i = available - 1; i >= available - take; i--) collected.push(events[i]);
      if (take < available) {
        return { collected, older: { line, skip: skip + take }, exhausted: false };
      }
      line -= 1;
      skip = 0;
    }
    return {
      collected,
      // When the limit landed exactly on a line boundary, unserved events
      // remain below `line`.
      ...(line >= 0 ? { older: { line, skip: 0 } } : {}),
      exhausted: line < 0,
    };
  }

  private parseLine(index: number): TranscriptEvent[] {
    const hit = this.parsedLines.get(index);
    if (hit) return hit;
    let events: TranscriptEvent[] = [];
    try {
      events = parseSessionLineEvents(
        this.appSessionId,
        this.providerSessionId,
        this.role,
        JSON.parse(this.lines[index]) as StoredMessageLine | StoredSessionStart,
      );
    } catch {
      /* skip partial/corrupt JSONL rows */
    }
    for (const e of events) {
      // Record even ts=0 (missing/invalid timestamp): the old eager parser
      // deduped the head divider by `e.ts === comp.ts`, where 0 === 0 holds.
      if (e.kind === 'compaction') this.compactionTimestamps.add(e.ts);
    }
    const base = (index + 1) * LINE_EVENT_STRIDE;
    events.forEach((e, i) => {
      e.seq = base + Math.min(i, LINE_EVENT_STRIDE - 1);
    });
    this.parsedLines.set(index, events);
    return events;
  }

  // The synthesized oldest entries of the segment: the head-read compaction
  // divider (unless the parse already replayed that same record) and the
  // oversized-trim status. Computed only once every line has been parsed, so
  // the divider dedupe sees the complete compaction set. Seqs are
  // segment-local (before every parsed line); callers add the chain base.
  private headEventsAtExhaustion(): TranscriptEvent[] {
    if (!this.headEvents) {
      const events: TranscriptEvent[] = [];
      // The head read backstops oversized files whose leading
      // compaction_state was tail-windowed away; when the parse already
      // replayed that same record as a divider, adding the head copy would
      // duplicate it.
      if (this.headCompaction && !this.compactionTimestamps.has(this.headCompaction.ts)) {
        events.push(
          compactionDividerEvent(this.appSessionId, this.providerSessionId, this.headCompaction),
        );
      }
      if (this.trimmed) {
        events.push(
          oversizedStatusEvent(this.appSessionId, this.providerSessionId, this.role, this.mtimeMs),
        );
      }
      events.forEach((e, i) => {
        e.seq = i;
      });
      this.headEvents = events;
    }
    return this.headEvents;
  }
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

function oversizedStatusEvent(
  appSessionId: string,
  providerSessionId: string,
  role: SessionRole,
  mtimeMs: number,
): TranscriptEvent {
  return event(
    {
      appSessionId,
      sourceProviderSessionId: providerSessionId,
      role,
      messageId: 'history-window',
      ts: mtimeMs,
    },
    0,
    'status',
    {
      text: `Loaded latest ${String(Math.round(MAX_SESSION_BYTES / 1_000_000))} MB of this oversized session for UI performance.`,
    },
  );
}
