// Stored-transcript line → TranscriptEvent translation.
//
// Each stored JSONL row converts to its events independently (no cross-line
// state), which is what makes the reader's backward, parse-on-demand
// windowing in sessionTranscript.ts safe. This module owns the line-to-event
// mapping, the canonical event builder, and the text shaping (trimming,
// system-text filtering, tool-result stringification) every parsed event
// shares.
import { dateMs, numberValue, objectValue, safeStringify, stringValue } from './values.js';
import { designPromptDisplayFromText } from './browser/designPromptDisplay.js';
import type { SessionRole, TranscriptEvent } from './protocol.js';

const MAX_TEXT_CHARS = 12_000;

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

// The fixed context every event parsed from one stored line shares.
interface EventBase {
  appSessionId: string;
  sourceProviderSessionId: string;
  role: SessionRole;
  messageId: string;
  ts: number;
}

// The first defined, non-empty string: what the `a || b || ''` chains in the
// original eager parser computed, kept exact (empty strings fall through).
function nonEmpty(...values: (string | undefined)[]): string {
  for (const value of values) if (value) return value;
  return '';
}

// Builds one TranscriptEvent from the shared per-line context. Exported so
// the reader can synthesize the oversized-trim status head event with the
// same canonical id / sourceSessionId rules.
export function event(
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
