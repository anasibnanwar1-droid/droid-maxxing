import type { TranscriptEvent } from '../types/bridge';
import type { ChildSessionInfo } from '../hooks/useStore';
import { childSessionInfo, toolMeta, CAT_LABEL } from './tools';

// A single Task spawn streams many tool_call/tool_call_delta events sharing one
// toolUseId; the subagent_type (label) and description can arrive in separate
// deltas, so merge their args rather than picking one event and dropping the
// field the other carried.
export function mergeChildSessionSpawn(
  existing: TranscriptEvent,
  next: TranscriptEvent,
): TranscriptEvent {
  const e = childSessionInfo(existing.toolArgs);
  const n = childSessionInfo(next.toolArgs);
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

export type ChildSessionLatest = {
  kind: TranscriptEvent['kind'];
  text?: string;
  toolName?: string;
  toolArgs?: unknown;
  isError?: boolean;
};

export type ChildSessionTarget = { toolUseId?: string; label?: string };

export type ChildSessionActivity = {
  status?: ChildSessionInfo['status'];
  startedAt?: number;
  latest?: ChildSessionLatest;
};

export function findChildSessionForTarget(
  childSessions: ChildSessionInfo[],
  target: ChildSessionTarget,
): ChildSessionInfo | undefined {
  if (target.toolUseId) {
    const byId = childSessions.find((childSession) => childSession.toolUseId === target.toolUseId);
    if (byId) return byId;
  }
  const label = target.label?.toLowerCase();
  if (!label) return undefined;
  const matches = childSessions.filter(
    (childSession) => (childSession.label ?? '').toLowerCase() === label,
  );
  return (
    matches.find((childSession) => childSession.status === 'running') ?? matches[matches.length - 1]
  );
}

export function childSessionActivityForTarget(
  childSessions: ChildSessionInfo[],
  allTx: TranscriptEvent[],
  target: ChildSessionTarget,
): ChildSessionActivity | undefined {
  const childSession = findChildSessionForTarget(childSessions, target);
  if (!childSession) return undefined;
  let latest: ChildSessionLatest | undefined;
  for (let i = allTx.length - 1; i >= 0; i--) {
    const t = allTx[i];
    if (
      t.sourceSessionId !== childSession.providerSessionId ||
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
  return { status: childSession.status, startedAt: childSession.startedAt, latest };
}

// Last non-empty line, capped, so a long thinking block stays a one-line cue.
export function previewLine(text?: string): string | undefined {
  if (!text) return undefined;
  const line = text.trim().split('\n').filter(Boolean).pop() ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line || undefined;
}

// Map the child session's newest transcript event to a short head + body, mirroring
// how the main feed labels thinking/tool steps.
export function childSessionLatest(
  latest: ChildSessionLatest | undefined,
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
