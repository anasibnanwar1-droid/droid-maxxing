import type { TranscriptEvent } from '../types/bridge';
import { isSubagentTool, isTodoTool } from './tools';
import { extractFileChange } from './diff';

// The explicit content taxonomy the transcript renderer is driven by. Classifying
// every event up front (instead of re-deriving from kind/tool-name heuristics at
// render time) is what lets the feed guarantee its invariants: chat content is
// never folded into activity, internal orchestration never poses as chat, and
// spec content only ever appears in the spec surface.
export type ContentType =
  | 'user'
  | 'assistant_chat'
  | 'thought'
  | 'tool_activity'
  | 'file_edit'
  | 'plan_update'
  | 'compaction'
  | 'subagent_event'
  | 'error'
  | 'status'
  | 'spec_content';

// Chat content must always render as a top-level transcript message and can
// never be nested inside a Worked/Thought/tool/compaction activity group.
const CHAT_CONTENT: ReadonlySet<ContentType> = new Set<ContentType>(['user', 'assistant_chat']);

// Internal orchestration that belongs only inside an optional activity
// disclosure, never as a standalone chat row.
const DIAGNOSTIC_CONTENT: ReadonlySet<ContentType> = new Set<ContentType>([
  'thought',
  'tool_activity',
  'file_edit',
  'plan_update',
]);

export function classifyEvent(ev: TranscriptEvent): ContentType {
  if (ev.author === 'user') return 'user';
  // A failed tool result or explicit error surfaces regardless of tool family.
  if (ev.kind === 'error' || ev.isError) return 'error';
  switch (ev.kind) {
    case 'text':
      return 'assistant_chat';
    case 'thinking':
      return 'thought';
    case 'compaction':
      return 'compaction';
    case 'status':
      return 'status';
    case 'tool_call':
    case 'tool_result':
      if (isSubagentTool(ev.toolName, ev.toolArgs)) return 'subagent_event';
      if (isTodoTool(ev.toolName)) return 'plan_update';
      if (ev.kind === 'tool_call' && extractFileChange(ev.toolName, ev.toolArgs)) return 'file_edit';
      return 'tool_activity';
    default:
      return 'status';
  }
}

export function isChatContent(type: ContentType): boolean {
  return CHAT_CONTENT.has(type);
}

export function isDiagnosticContent(type: ContentType): boolean {
  return DIAGNOSTIC_CONTENT.has(type);
}

// The terminal assistant answer of a turn. Marked by the backend (live + on
// reload); used as a hard guard that the answer stays a top-level message.
export function isAssistantFinal(ev: TranscriptEvent): boolean {
  return ev.kind === 'text' && !ev.author && ev.final === true;
}
