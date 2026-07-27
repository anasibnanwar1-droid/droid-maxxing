import type { TranscriptEvent } from '../types/bridge';
import type { WorkerInfo } from '../hooks/useStore';
import { subagentInfo, toolMeta, CAT_LABEL } from './tools';

// Child-session links are canonical protocol data. The renderer never guesses
// provider identities from transcript order.
export function resolveWorkers(
  workers: WorkerInfo[],
  _transcript: TranscriptEvent[],
): WorkerInfo[] {
  return workers;
}

// A single Task spawn streams many tool_call/tool_call_delta events sharing one
// toolUseId; the subagent_type (label) and description can arrive in separate
// deltas, so merge their args rather than picking one event and dropping the
// field the other carried.
export function richerSubagent(existing: TranscriptEvent, next: TranscriptEvent): TranscriptEvent {
  const e = subagentInfo(existing.toolArgs);
  const n = subagentInfo(next.toolArgs);
  const label = n.label ?? e.label;
  const description = n.description ?? e.description;
  // The latest delta is the freshest base; only rebuild its args when an earlier
  // delta carried a label/description this one is missing.
  if (label === n.label && description === n.description) return next;
  const base =
    next.toolArgs && typeof next.toolArgs === 'object'
      ? (next.toolArgs as Record<string, unknown>)
      : {};
  return {
    ...next,
    toolArgs: {
      ...base,
      ...(label ? { subagent_type: label } : {}),
      ...(description ? { description } : {}),
    },
  };
}

export type SubagentLatest = {
  kind: TranscriptEvent['kind'];
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  isError?: boolean;
};

export type SubagentTarget = { toolUseId?: string; label?: string };

export type SubagentActivity = {
  status?: WorkerInfo['status'];
  startedAt?: number;
  latest?: SubagentLatest;
};

export function findWorkerForTarget(
  workers: WorkerInfo[],
  target: SubagentTarget,
): WorkerInfo | undefined {
  if (target.toolUseId) {
    const byId = workers.find((w) => w.toolUseId === target.toolUseId);
    if (byId) return byId;
  }
  const label = target.label?.toLowerCase();
  if (!label) return undefined;
  const matches = workers.filter((w) => (w.label ?? '').toLowerCase() === label);
  return matches.find((w) => w.status === 'running') ?? matches[matches.length - 1];
}

export function subagentActivityForTarget(
  workers: WorkerInfo[],
  allTx: TranscriptEvent[],
  target: SubagentTarget,
): SubagentActivity | undefined {
  const worker = findWorkerForTarget(workers, target);
  if (!worker) return undefined;
  let latest: SubagentLatest | undefined;
  for (let i = allTx.length - 1; i >= 0; i--) {
    const t = allTx[i];
    if (
      t.sourceSessionId !== worker.providerSessionId ||
      (t.kind === 'tool_result' && !t.isError) ||
      t.author === 'user'
    )
      continue;
    latest = {
      kind: t.kind,
      text: t.text,
      toolName: t.toolName,
      toolArgs: t.toolArgs,
      isError: t.isError,
    };
    break;
  }
  return { status: worker.status, startedAt: worker.startedAt, latest };
}

// Last non-empty line, capped, so a long thinking block stays a one-line cue.
export function previewLine(text?: string): string | undefined {
  if (!text) return undefined;
  const line = text.trim().split('\n').filter(Boolean).pop() ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line || undefined;
}

// Map the subagent's newest transcript event to a short head + body, mirroring
// how the main feed labels thinking/tool steps.
export function subagentLatest(
  latest: SubagentLatest | undefined,
): { head: string; body?: string } | null {
  if (!latest) return null;
  // A failed tool result is surfaced by the activity scanners (which skip only
  // successful results), so render it as a failure instead of stale "Working".
  if (latest.isError || latest.kind === 'error') {
    const { detail } = toolMeta(latest.toolName, latest.toolArgs);
    return {
      head: latest.kind === 'tool_result' ? 'Failed' : 'Error',
      body: previewLine(latest.text) || detail || latest.toolName,
    };
  }
  switch (latest.kind) {
    case 'thinking':
      return { head: 'Thinking', body: previewLine(latest.text) };
    case 'tool_call': {
      const { cat, detail } = toolMeta(latest.toolName, latest.toolArgs);
      return { head: CAT_LABEL[cat], body: detail || latest.toolName };
    }
    case 'text':
      return { head: 'Responding', body: previewLine(latest.text) };
    case 'status':
      return { head: 'Working', body: previewLine(latest.text) };
    default:
      return { head: 'Working', body: previewLine(latest.text) };
  }
}
