import type { TranscriptEvent } from '../types/bridge';
import type { WorkerInfo } from '../hooks/useStore';
import { isSubagentTool, subagentInfo, toolMeta, CAT_LABEL } from './tools';

// Fallback for older history that predates persisted links: reconstruct a worker
// list from the transcript by pairing each orchestrator subagent spawn with a
// worker session in first-seen order (mirrors the live pendingSubagent fallback).
export function reconstructWorkersFromTranscript(allTx: TranscriptEvent[]): WorkerInfo[] {
  const workerOrder: string[] = [];
  const seenSession = new Set<string>();
  for (const t of allTx) {
    if (t.role === 'orchestrator' || t.author === 'user') continue;
    if (!seenSession.has(t.agentSessionId)) {
      seenSession.add(t.agentSessionId);
      workerOrder.push(t.agentSessionId);
    }
  }
  if (workerOrder.length === 0) return [];
  const spawns: { toolUseId?: string; label?: string }[] = [];
  const seenSpawn = new Set<string>();
  for (const t of allTx) {
    if (t.role !== 'orchestrator' || t.kind !== 'tool_call' || !isSubagentTool(t.toolName, t.toolArgs)) continue;
    const key = t.toolUseId ?? t.id;
    if (seenSpawn.has(key)) continue;
    seenSpawn.add(key);
    spawns.push({ toolUseId: t.toolUseId, label: subagentInfo(t.toolArgs).label });
  }
  return workerOrder.map((sessionId, i) => ({
    sessionId,
    status: 'completed' as const,
    startedAt: 0,
    label: spawns[i]?.label,
    toolUseId: spawns[i]?.toolUseId,
  }));
}

// Prefer live/persisted workers, then merge in any transcript-reconstructed
// workers whose session isn't already covered. A long-lived session can mix
// older unlinked spawns with newer persisted links, so returning only the
// linked workers would leave the older historical subagent lines unopenable.
export function resolveWorkers(missionWorkers: WorkerInfo[], allTx: TranscriptEvent[]): WorkerInfo[] {
  if (missionWorkers.length === 0) return reconstructWorkersFromTranscript(allTx);
  const known = new Set(missionWorkers.map((w) => w.sessionId));
  const extra = reconstructWorkersFromTranscript(allTx).filter((w) => !known.has(w.sessionId));
  return extra.length === 0 ? missionWorkers : [...missionWorkers, ...extra];
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
  const base = next.toolArgs && typeof next.toolArgs === 'object' ? (next.toolArgs as Record<string, unknown>) : {};
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

// Last non-empty line, capped, so a long thinking block stays a one-line cue.
export function previewLine(text?: string): string | undefined {
  if (!text) return undefined;
  const line = text.trim().split('\n').filter(Boolean).pop() ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line || undefined;
}

// Map the subagent's newest transcript event to a short head + body, mirroring
// how the main feed labels thinking/tool steps.
export function subagentLatest(latest: SubagentLatest | undefined): { head: string; body?: string } | null {
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
