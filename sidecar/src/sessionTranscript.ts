// Lazy session transcript reader.
//
// Opening a session must not parse a multi-MB JSONL file upfront: the reader
// holds the (tail-windowed) raw lines and JSON.parses them backward, newest
// first, only as far as each requested window needs. Paging older history
// parses a few hundred more lines per page instead of re-reading the whole
// file, and the per-line parse memo makes repeat pages and reopens free.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dateMs, numberValue, objectValue, safeStringify, stringValue } from './values.js';
import { designPromptDisplayFromText } from './browser/designPromptDisplay.js';
import type { SessionRole, TranscriptEvent } from './protocol.js';

// Oversized session files are tail-windowed to the newest bytes; the dropped
// head is surfaced as a status event when paging reaches the top.
export const MAX_SESSION_BYTES = 5_000_000;
// The session_start / leading compaction_state records live at the head of the
// file; readers cap that head read instead of scanning the whole file.
export const SESSION_START_BYTES = 256_000;
const MAX_TEXT_CHARS = 12_000;
// seq band per line: a line yields one event per content block, so (line,
// event-in-line) maps to a unique, stable, monotonically increasing seq
// within a segment. 256 far exceeds any real message's block count; a freak
// line with more blocks clamps onto the last band slot (order within that
// line is then kept by array order, not seq).
const LINE_EVENT_STRIDE = 256;

export interface StoredMessageLine {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown[];
    visibility?: unknown;
  };
}

export interface StoredSessionStart {
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

// Reads from the HEAD of the file (compaction_state is a leading record); the
// transcript reader tail-windows oversized files and would miss it.
function readCompactionState(path: string): CompactionState | null {
  const size = statSync(path).size;
  const bytes = Math.min(size, SESSION_START_BYTES);
  const fd = openSync(path, 'r');
  let rows: { type?: string; timestamp?: string; removedCount?: unknown }[];
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

// The first defined, non-empty string: what the `a || b || ''` chains in the
// original eager parser computed, kept exact (empty strings fall through).
function nonEmpty(...values: (string | undefined)[]): string {
  for (const value of values) if (value) return value;
  return '';
}

// The fixed context every event parsed from one stored line shares.
interface EventBase {
  appSessionId: string;
  sourceProviderSessionId: string;
  role: SessionRole;
  messageId: string;
  ts: number;
}

function assistantBlockEvent(
  base: EventBase,
  index: number,
  block: Record<string, unknown>,
): TranscriptEvent | null {
  const type = stringValue(block.type);
  if (type === 'thinking') {
    const text = trimText(nonEmpty(stringValue(block.thinking), stringValue(block.text)));
    return text ? event(base, index, 'thinking', { text }) : null;
  }
  if (type === 'text') {
    const text = trimText(nonEmpty(stringValue(block.text)));
    return text ? event(base, index, 'text', { text }) : null;
  }
  if (type === 'tool_use') {
    return event(base, index, 'tool_call', {
      toolName: nonEmpty(stringValue(block.name), 'tool'),
      toolArgs: block.input,
      // Carry the tool_use id so persisted child-session links resolve exactly
      // (duplicate-label spawns would otherwise fall back to label match).
      toolUseId: stringValue(block.id),
    });
  }
  return null;
}

function nonAssistantBlockEvent(
  base: EventBase,
  index: number,
  block: Record<string, unknown>,
  messageRole: string | undefined,
): TranscriptEvent | null {
  const type = stringValue(block.type);
  if (type === 'tool_result') {
    return event(base, index, 'tool_result', {
      toolName: stringValue(block.name),
      text: trimText(stringifyToolResult(block.content)),
      isError: Boolean(block.is_error ?? block.isError),
      // Carry the originating call's id so the renderer can correlate a
      // result to its tool_call exactly (result blocks have no name and
      // may not be adjacent to their call after replay/batching).
      toolUseId: stringValue(block.tool_use_id ?? block.toolUseId) ?? undefined,
    });
  }
  if (messageRole === 'user' && base.role === 'primary' && type === 'text') {
    const rawText = trimText(nonEmpty(stringValue(block.text)));
    const display = designPromptDisplayFromText(rawText);
    const text = display?.text ?? rawText;
    if (!text || isSystemText(text)) return null;
    return event({ ...base, sourceProviderSessionId: 'user', role: 'primary' }, index, 'text', {
      text,
      author: 'user',
      browserRefs: display?.browserRefs,
    });
  }
  return null;
}

// Map one stored JSONL row to its transcript events. Each line converts
// independently (no cross-line state), which is what makes backward,
// parse-on-demand windowing safe.
export function parseSessionLineEvents(
  appSessionId: string,
  providerSessionId: string,
  role: SessionRole,
  line: StoredMessageLine | StoredSessionStart,
): TranscriptEvent[] {
  // In-place daemon auto-compaction appends a compaction_state marker to the
  // SAME session file, so a mid-file record marks a summarize-away boundary
  // that must replay as a divider (leading records are handled by the
  // segment's head read, which the reader dedupes against).
  if (line.type === 'compaction_state') {
    const raw = line as Record<string, unknown>;
    const ts = dateMs(stringValue(raw.timestamp)) || 0;
    return [
      event(
        {
          appSessionId,
          sourceProviderSessionId: providerSessionId,
          role,
          messageId: nonEmpty(line.id, `compaction-${String(ts)}`),
          ts,
        },
        0,
        'compaction',
        { removedCount: numberValue(raw.removedCount) },
      ),
    ];
  }
  if (line.type !== 'message' || !('message' in line)) return [];
  const message = line.message;
  // Internal orchestration context is model-visible, not a user conversation turn.
  if (message?.visibility === 'llm_only') return [];
  const content = Array.isArray(message?.content) ? message.content : [];
  const ts = dateMs(line.timestamp) || Date.now();
  const base: EventBase = {
    appSessionId,
    sourceProviderSessionId: providerSessionId,
    role,
    messageId: nonEmpty(line.id, `${providerSessionId}-${String(ts)}`),
    ts,
  };
  const messageRole = message?.role;

  const events: TranscriptEvent[] = [];
  content.forEach((item, index) => {
    const block = objectValue(item);
    if (!block) return;
    const parsed =
      messageRole === 'assistant'
        ? assistantBlockEvent(base, index, block)
        : nonAssistantBlockEvent(base, index, block, messageRole);
    if (parsed) events.push(parsed);
  });
  return events;
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

function event(
  base: EventBase,
  index: number,
  kind: TranscriptEvent['kind'],
  extra: Partial<TranscriptEvent>,
): TranscriptEvent {
  return {
    id: `${base.sourceProviderSessionId}:${base.messageId}:${String(index)}:${kind}`,
    appSessionId: base.appSessionId,
    sourceSessionId:
      base.role === 'primary' && base.sourceProviderSessionId !== 'user'
        ? 'primary'
        : base.sourceProviderSessionId,
    role: base.role,
    ts: base.ts,
    kind,
    ...extra,
  };
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const block = objectValue(item);
        return nonEmpty(stringValue(block?.text), safeStringify(item));
      })
      .filter(Boolean)
      .join('\n');
  }
  return safeStringify(value);
}

function trimText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated ${String(text.length - MAX_TEXT_CHARS)} chars]`;
}

function isSystemText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('<system-reminder>') || trimmed.startsWith('IMPORTANT:');
}
