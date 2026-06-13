import type { TranscriptEvent } from '../types/bridge';
import type { WorkerInfo } from '../hooks/useStore';
import { isSubagentTool, subagentInfo, toolMeta, CAT_LABEL } from './tools';

type ReconstructExclude = { sessions?: Set<string>; toolUseIds?: Set<string> };

// Fallback for older history that predates persisted links: reconstruct a worker
// list from the transcript by pairing each orchestrator subagent spawn with the
// worker session it launched (mirrors the live pendingSubagent fallback).
//
// `exclude` lets the caller drop sessions/spawns already covered by persisted
// links so the remaining unlinked workers are paired only against the remaining
// unlinked spawns. Pairing is CAUSAL rather than positional: a spawn always
// precedes the worker it starts, so each worker (in first-event order) claims
// the oldest not-yet-claimed spawn that occurred before it. This keeps Task
// lines mapped to the right worker even when workers run concurrently, their
// events interleave out of spawn order, or an unrelated session (e.g. a
// validator with no spawn) appears between spawns.
export function reconstructWorkersFromTranscript(allTx: TranscriptEvent[], exclude?: ReconstructExclude): WorkerInfo[] {
  const workers: { sessionId: string; firstTs: number }[] = [];
  const seenSession = new Set<string>();
  const spawns: { toolUseId?: string; label?: string; ts: number }[] = [];
  const seenSpawn = new Set<string>();
  for (const t of allTx) {
    if (t.role === 'orchestrator') {
      if (t.kind !== 'tool_call' || !isSubagentTool(t.toolName, t.toolArgs)) continue;
      const key = t.toolUseId ?? t.id;
      if (seenSpawn.has(key)) continue;
      seenSpawn.add(key);
      if (exclude?.toolUseIds && t.toolUseId && exclude.toolUseIds.has(t.toolUseId)) continue;
      spawns.push({ toolUseId: t.toolUseId, label: subagentInfo(t.toolArgs).label, ts: t.ts });
      continue;
    }
    if (t.author === 'user') continue;
    if (seenSession.has(t.agentSessionId)) continue;
    seenSession.add(t.agentSessionId);
    if (exclude?.sessions?.has(t.agentSessionId)) continue;
    workers.push({ sessionId: t.agentSessionId, firstTs: t.ts });
  }
  if (workers.length === 0) return [];

  const byTsWorkers = [...workers].sort((a, b) => a.firstTs - b.firstTs);
  const byTsSpawns = [...spawns].sort((a, b) => a.ts - b.ts);
  const assigned = new Map<string, { toolUseId?: string; label?: string }>();
  const pending: { toolUseId?: string; label?: string }[] = [];
  let si = 0;
  for (const w of byTsWorkers) {
    while (si < byTsSpawns.length && byTsSpawns[si].ts <= w.firstTs) {
      pending.push({ toolUseId: byTsSpawns[si].toolUseId, label: byTsSpawns[si].label });
      si++;
    }
    const spawn = pending.shift();
    if (spawn) assigned.set(w.sessionId, spawn);
  }
  // Preserve first-seen worker order in the returned list (callers render it as
  // the worker panel order); only the spawn->worker pairing used time.
  return workers.map((w) => ({
    sessionId: w.sessionId,
    status: 'completed' as const,
    startedAt: 0,
    label: assigned.get(w.sessionId)?.label,
    toolUseId: assigned.get(w.sessionId)?.toolUseId,
  }));
}

// Prefer live/persisted workers, then merge in any transcript-reconstructed
// workers whose session isn't already covered. A long-lived session can mix
// older unlinked spawns with newer persisted links, so returning only the
// linked workers would leave the older historical subagent lines unopenable.
export function resolveWorkers(missionWorkers: WorkerInfo[], allTx: TranscriptEvent[]): WorkerInfo[] {
  if (missionWorkers.length === 0) return reconstructWorkersFromTranscript(allTx);
  const known = new Set(missionWorkers.map((w) => w.sessionId));
  // Exclude the spawns already claimed by linked workers before pairing, so a
  // linked worker can't consume an unlinked worker's spawn (and vice versa) and
  // mis-map the remaining Task lines.
  const claimedToolUseIds = new Set(
    missionWorkers.map((w) => w.toolUseId).filter((id): id is string => Boolean(id)),
  );
  const extra = reconstructWorkersFromTranscript(allTx, { sessions: known, toolUseIds: claimedToolUseIds });
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

export type SubagentTarget = { toolUseId?: string; label?: string };

export type SubagentActivity = {
  status?: WorkerInfo['status'];
  startedAt?: number;
  latest?: SubagentLatest;
};

export function findWorkerForTarget(workers: WorkerInfo[], target: SubagentTarget): WorkerInfo | undefined {
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
    if (t.agentSessionId !== worker.sessionId || (t.kind === 'tool_result' && !t.isError) || t.author === 'user') continue;
    latest = { kind: t.kind, text: t.text, toolName: t.toolName, toolArgs: t.toolArgs, isError: t.isError };
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
