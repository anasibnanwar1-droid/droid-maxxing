// Subagent (Task tool) signal parsing. Everything the bridge knows about a
// subagent it learns from the parent's own tool traffic: the Task tool_call that
// spawns it, and the Task/TaskOutput results that acknowledge, poll, and settle
// it. Those content shapes belong to the SDK's Task tools rather than to the
// stream protocol, so they live here — one cohesive responsibility with its own
// tests — instead of inside the generic event normalizer.

import type { ChildActivity } from './protocol.js';
import { trimmedString as str } from './values.js';

// What a single event tells us about one child session. Fields are all optional
// because different events carry different fragments; the child session store
// merges them.
export interface ChildSessionSignal {
  providerSessionId?: string;
  toolUseId?: string;
  label?: string;
  prompt?: string;
  done?: boolean;
  activity?: ChildActivity;
}

export function taskPrompt(input: Record<string, unknown>): string | undefined {
  for (const key of ['prompt', 'task', 'instructions', 'message', 'description', 'input']) {
    const value = str(input[key]);
    if (value) return value;
  }
  return undefined;
}

// The SDK subagent spawn is the `Task` tool. Match "task" as a whole word so
// unrelated tools whose names merely contain it (e.g. `create_task`) are never
// mistaken for a spawn.
export const isTaskToolName = (name: unknown): boolean =>
  typeof name === 'string' && /\btask\b/i.test(name);

// The bookkeeping companions of a spawn: `TaskOutput` polls a background
// subagent and `TaskStop` cancels one. They are not spawns — their tool_use id
// must never become a child's spawn link — but their results are the only place
// a subagent's status is reported.
const TASK_COMPANION_TOOL = /^task[_ -]?(output|stop)$/i;

// Every tool whose result can legitimately describe a subagent.
export const isTaskFamilyToolName = (name: unknown): boolean =>
  isTaskToolName(name) || (typeof name === 'string' && TASK_COMPANION_TOOL.test(name.trim()));

// A standard chat can spawn Factory subagents via the Task tool; those surface
// as ToolProgress events carrying raw `subagentSessionId` metadata.
export function detectChildSession(
  toolName: unknown,
  input: Record<string, unknown>,
  providerSessionId: string | undefined,
  toolUseId: string | undefined,
): ChildSessionSignal | undefined {
  const isTask =
    isTaskToolName(toolName) ||
    typeof input.subagent_type === 'string' ||
    typeof input.subagentType === 'string';
  if (!isTask && !providerSessionId) return undefined;
  const label =
    str(input.subagent_type) ??
    str(input.subagentType) ??
    str(input.description) ??
    (typeof toolName === 'string' ? toolName : undefined);
  return { providerSessionId, toolUseId, label, prompt: taskPrompt(input) };
}

// The primary session's Task tool_call carries the entire subagent prompt in its
// input. That prompt belongs in the subagent's own pane, not the main feed, so
// we keep only the lightweight label fields on the transcript copy.
export function slimChildSessionArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['subagent_type', 'subagentType', 'description']) {
    if (typeof input[key] === 'string') out[key] = input[key];
  }
  return out;
}

export interface TaskResultChildUpdate {
  providerSessionId: string;
  done: boolean;
  // Spawn results (the foreground final result, or the background
  // "Task launched" acknowledgement) are keyed by the spawning tool_use id, so
  // the observation may carry it as the child's spawn link. Poll/notification
  // results ("Task ID: … Status: …") belong to a *different* tool_use; their id
  // must never become the child's spawn link.
  isSpawnResult: boolean;
  // What the subagent is doing right now, as reported by a poll. Autonomous
  // children stream no transcript to the parent, so a poll's status line is the
  // only live activity signal the parent ever sees.
  activity?: ChildActivity;
}

// The report's own field lines describe the task, not what it is doing; a body
// that is still empty must yield no preview rather than "Duration: 12.0s".
const POLL_HEADER_FIELD =
  /^(Task ID|Subagent Type|Description|Status|Duration|Output|Result|Error):/i;

// The poll body is a header block followed by whatever the subagent has produced
// so far. The last non-header line is the closest thing to "what it is doing".
function pollActivity(content: string, status: string | undefined): ChildActivity | undefined {
  const phase = status ? status[0].toUpperCase() + status.slice(1) : undefined;
  const lines = content.split('\n');
  let preview: string | undefined;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || POLL_HEADER_FIELD.test(line)) continue;
    preview = line.length > 160 ? `${line.slice(0, 159)}…` : line;
    break;
  }
  if (!phase && !preview) return undefined;
  return { ...(phase ? { phase } : {}), ...(preview ? { preview } : {}) };
}

const TERMINAL_POLL_STATUS = new Set(['completed', 'failed', 'stopped', 'cancelled']);

const LAUNCH_ID_RE = /^(?:session_id|task_id):[ \t]*(\S+)[ \t]*$/m;
const SPAWN_FINAL_RE = /^session_id:[ \t]*(\S+)[ \t]*$/;
const POLL_ID_RE = /^Task ID:[ \t]*(\S+)[ \t]*$/;
const POLL_STATUS_RE = /^Status:[ \t]*(\w+)[ \t]*$/im;

// Subagent Task-family results arrive in three content shapes, told apart by
// their FIRST line (the report body itself may mention task ids or statuses):
//   foreground final:  "session_id: <id>\n\n<output>"
//   background launch: "Task launched in background.\ntask_id: <id>\nsession_id: <id>\n…"
//   poll/completion:   "Task ID: <id>\nSubagent Type: …\nStatus: running|completed|…\n…"
export function taskResultChildUpdate(
  toolName: unknown,
  content: unknown,
): TaskResultChildUpdate | undefined {
  if (typeof content !== 'string') return undefined;
  // Only the Task family reports subagent state. Ordinary tool output that
  // happens to open with "Task ID:" (a log, a pasted report, a grep hit) must
  // never mint a phantom child. A result with no tool name at all is still
  // parsed: some paths omit the name, and refusing those would drop real
  // subagent completions.
  const named = str(toolName);
  if (named && !isTaskFamilyToolName(named)) return undefined;
  // Poll bodies can arrive with CRLF endings. Normalizing them once keeps the
  // blank-line header bound working: without it the whole body counts as header
  // and a body line like "Status: completed" can settle a running child.
  const text = content.replace(/\r\n/g, '\n');
  // The header is the field block before the first blank line. Bounding it by
  // structure rather than a character budget keeps a long Description from
  // pushing the Status line out of range and making a running task look done.
  const blankLine = text.indexOf('\n\n');
  const header = blankLine === -1 ? text : text.slice(0, blankLine);
  const firstLine = header.split('\n', 1)[0];
  if (firstLine.startsWith('Task launched in background')) {
    const providerSessionId = LAUNCH_ID_RE.exec(header)?.[1];
    return providerSessionId ? { providerSessionId, done: false, isSpawnResult: true } : undefined;
  }
  const spawnFinal = SPAWN_FINAL_RE.exec(firstLine);
  if (spawnFinal) return { providerSessionId: spawnFinal[1], done: true, isSpawnResult: true };
  const poll = POLL_ID_RE.exec(firstLine);
  if (!poll) return undefined;
  const status = POLL_STATUS_RE.exec(header)?.[1]?.toLowerCase();
  const activity = pollActivity(text, status);
  return {
    providerSessionId: poll[1],
    // Only a reported terminal status settles the child: a poll that reports no
    // status says nothing about completion, and assuming it finished would stop
    // the clock on a subagent that is still working.
    done: status ? TERMINAL_POLL_STATUS.has(status) : false,
    isSpawnResult: false,
    ...(activity ? { activity } : {}),
  };
}
