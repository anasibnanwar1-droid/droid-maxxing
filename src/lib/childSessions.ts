import type { ProgressEntry, TranscriptEvent } from '../types/bridge';
import type { ChildAccess, ChildSessionInfo } from '../hooks/useStore';
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
  status?: 'running' | 'paused' | 'completed';
  startedAt?: number;
  latest?: ChildSessionLatest;
};

export type VisibleSessionTarget =
  | { kind: 'primary' }
  | {
      kind: 'child';
      parentAppSessionId: string;
      childSessionId: string;
      child: ChildSessionInfo;
      access: ChildAccess | undefined;
      canSend: boolean;
      canInterrupt: boolean;
      settingsReadiness: 'opening' | 'ready' | 'failed';
    };

export function selectedChildForParent(
  activeAppSessionId: string | undefined,
  selection: { parentAppSessionId: string; childSessionId: string } | null,
  childrenByParent: Record<string, Record<string, ChildSessionInfo>>,
): ChildSessionInfo | undefined {
  if (!activeAppSessionId || selection?.parentAppSessionId !== activeAppSessionId) return undefined;
  return childrenByParent[activeAppSessionId]?.[selection.childSessionId];
}

export function visibleSessionTarget(
  activeAppSessionId: string | undefined,
  selection: { parentAppSessionId: string; childSessionId: string } | null,
  childrenByParent: Record<string, Record<string, ChildSessionInfo>>,
  accessByParent: Record<string, Record<string, ChildAccess>>,
): VisibleSessionTarget {
  const child = selectedChildForParent(activeAppSessionId, selection, childrenByParent);
  if (!activeAppSessionId || !selection || !child) return { kind: 'primary' };
  const access = accessByParent[activeAppSessionId]?.[selection.childSessionId];
  const ready = access?.state === 'ready' && child.status !== 'completed';
  return {
    kind: 'child',
    parentAppSessionId: activeAppSessionId,
    childSessionId: selection.childSessionId,
    child,
    access,
    canSend: ready,
    canInterrupt: ready && child.status === 'running',
    settingsReadiness:
      child.status === 'completed'
        ? 'failed'
        : ready
          ? 'ready'
          : access === undefined || access.state === 'opening'
            ? 'opening'
            : 'failed',
  };
}

export function visibleSessionIsPending(
  target: VisibleSessionTarget,
  primaryIsLive: boolean,
  activeAgentId: string | null,
): boolean {
  return target.kind === 'child'
    ? target.canInterrupt
    : primaryIsLive && activeAgentId === 'primary';
}

export function visibleSessionCanCompact(target: VisibleSessionTarget): boolean {
  return target.kind === 'primary';
}

export function transcriptForVisibleSession(
  transcript: TranscriptEvent[],
  childSessionId: string | null,
): TranscriptEvent[] {
  if (childSessionId) {
    return transcript.filter((event) => event.sourceSessionId === childSessionId);
  }
  return transcript.filter(
    (event) =>
      event.role === 'primary' || (event.author === 'user' && event.sourceSessionId === 'user'),
  );
}

export function shouldOpenSelectedChild(access: ChildAccess | undefined): boolean {
  return access === undefined;
}

export function childSessionIdForFeature(
  progress: ProgressEntry[],
  featureId: string,
): string | undefined {
  for (let i = progress.length - 1; i >= 0; i--) {
    const entry = progress[i];
    if (entry.featureId === featureId && entry.workerChildSessionId) {
      return entry.workerChildSessionId;
    }
  }
  return undefined;
}

export function childSelectionForFeature(
  progress: ProgressEntry[],
  childSessions: ChildSessionInfo[],
  featureId: string,
): string | null {
  const childSessionId = childSessionIdForFeature(progress, featureId);
  return childSessionId &&
    childSessions.some((childSession) => childSession.childSessionId === childSessionId)
    ? childSessionId
    : null;
}

export function orderedChildSessions(
  childSessions: readonly ChildSessionInfo[],
): ChildSessionInfo[] {
  return [...childSessions].sort(
    (a, b) =>
      (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.childSessionId.localeCompare(b.childSessionId),
  );
}

export function childSessionIsLive(
  childSession: Pick<ChildSessionInfo, 'status'>,
  runtime?: { available: boolean },
): boolean {
  return childSession.status === 'running' && runtime?.available === true;
}

export function childSessionLabel(childSession: ChildSessionInfo, index: number): string {
  if (childSession.label) return childSession.label;
  const role = childSession.role === 'validator' ? 'Validator' : 'Worker';
  return `${role} ${index + 1}`;
}

export function childSessionMeta(
  childSession: ChildSessionInfo,
  displayedModel = childSession.modelId,
): string {
  return [
    childSession.role,
    childSession.status,
    displayedModel,
    childSession.reasoningEffort,
    childSession.transcriptAvailable ? 'transcript' : 'no transcript',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function findChildSessionForTarget(
  childSessions: ChildSessionInfo[],
  target: ChildSessionTarget,
): ChildSessionInfo | undefined {
  if (!target.toolUseId) return undefined;
  return childSessions.find(
    (childSession) =>
      childSession.spawnLink?.kind === 'tool-use' && childSession.spawnLink.id === target.toolUseId,
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
      t.appSessionId !== childSession.parentAppSessionId ||
      t.sourceSessionId !== childSession.childSessionId ||
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
  return {
    status: childSession.status === 'pending' ? 'paused' : childSession.status,
    startedAt: childSession.startedAt,
    latest,
  };
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
