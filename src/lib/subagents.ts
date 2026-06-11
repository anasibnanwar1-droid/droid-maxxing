import type { TranscriptEvent, WorkerHistoryLink } from '../types/bridge';
import type { WorkerInfo } from '../hooks/useStore';
import { isSubagentTool, subagentInfo } from './tools';

// Build worker entries from a persisted exact spawn->worker mapping (the precise
// path used for missions recorded after links were persisted).
export function workersFromLinks(links: WorkerHistoryLink[] | undefined): WorkerInfo[] {
  if (!links || links.length === 0) return [];
  return links.map((link) => ({
    sessionId: link.workerSessionId,
    // The backend attaches live status for active missions; historical loads
    // omit it, so default to completed.
    status: link.status ?? 'completed',
    startedAt: 0,
    label: link.label,
    toolUseId: link.toolUseId,
  }));
}

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
