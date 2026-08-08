import type { ChildStatus, ProgressEntry, TranscriptEvent } from '../types/bridge';
import type { ChildAccess, ChildSessionInfo } from '../hooks/useStore';
import { childSessionInfo, isChildSessionTool, toolMeta, CAT_LABEL } from './tools';

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
  // The spawn happened when its first event arrived; later deltas only refine
  // the args, so the earliest identity and timestamp stay authoritative — a row
  // timed from the last delta would start a beat late.
  const origin = { id: existing.id, ts: existing.ts };
  // The latest delta is the freshest base; only rebuild its args when an earlier
  // delta carried a label/description this one is missing.
  if (label === n.label && description === n.description) return { ...next, ...origin };
  const base =
    next.toolArgs && typeof next.toolArgs === 'object'
      ? (next.toolArgs as Record<string, unknown>)
      : {};
  return {
    ...next,
    ...origin,
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
  // The store's child status passes through verbatim; autonomous subagents
  // never open a runtime, so nothing here demotes running to paused.
  status?: ChildStatus;
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

export type ChildRuntimeSubmitTarget = {
  parentAppSessionId: string;
  childSessionId: string;
  runtimeGeneration: number;
};

export function childRuntimeSubmitTarget(
  target: VisibleSessionTarget,
): ChildRuntimeSubmitTarget | undefined {
  if (target.kind !== 'child' || !target.canSend || target.access?.state !== 'ready')
    return undefined;
  return {
    parentAppSessionId: target.parentAppSessionId,
    childSessionId: target.childSessionId,
    runtimeGeneration: target.access.runtimeGeneration,
  };
}

export async function commitChildPromptAfterBaseline({
  capturedTarget,
  capturedComposerRevision,
  waitForBaseline,
  currentTarget,
  currentComposerRevision,
  appendTranscript,
  resetComposer,
  sendCommand,
}: {
  capturedTarget: ChildRuntimeSubmitTarget;
  capturedComposerRevision: number;
  waitForBaseline: () => Promise<void>;
  currentTarget: () => VisibleSessionTarget;
  currentComposerRevision: () => number;
  appendTranscript: () => void;
  resetComposer: () => void;
  sendCommand: () => void;
}): Promise<boolean> {
  await waitForBaseline();
  const current = childRuntimeSubmitTarget(currentTarget());
  if (
    current?.parentAppSessionId !== capturedTarget.parentAppSessionId ||
    current.childSessionId !== capturedTarget.childSessionId ||
    current.runtimeGeneration !== capturedTarget.runtimeGeneration
  )
    return false;
  appendTranscript();
  if (currentComposerRevision() === capturedComposerRevision) resetComposer();
  sendCommand();
  return true;
}

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
    // Autonomy is only known once a live runtime confirmed it; a parent value
    // must never stand in for an unopened or historical child.
    childSession.autonomy ? `${childSession.autonomy} autonomy` : 'provider managed',
    childSession.transcriptAvailable ? 'transcript' : 'no transcript',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function findChildSessionForTarget(
  childSessions: readonly ChildSessionInfo[],
  target: ChildSessionTarget,
): ChildSessionInfo | undefined {
  if (!target.toolUseId) return undefined;
  return childSessions.find(
    (childSession) =>
      childSession.spawnLink?.kind === 'tool-use' && childSession.spawnLink.id === target.toolUseId,
  );
}

// The spawn-event fields the dock needs to synthesize a placeholder session.
type ChildSessionSpawnRef = Pick<
  TranscriptEvent,
  'id' | 'toolUseId' | 'appSessionId' | 'ts' | 'endTs' | 'toolArgs'
>;

// Resolve each spawn in a wave to its registered child session. A spawn whose
// session hasn't reached the store yet gets a placeholder built from the spawn
// event itself, so the dock card renders the instant the spawn streams in
// instead of flashing per-spawn lines while the store catches up.
export function resolveWaveSessions(
  spawns: readonly ChildSessionSpawnRef[],
  childSessions: readonly ChildSessionInfo[],
  live = false,
): ChildSessionInfo[] {
  return spawns.map((spawn) => {
    const registered = findChildSessionForTarget(childSessions, { toolUseId: spawn.toolUseId });
    // The store stamps startedAt when the child session registers, which lags
    // the actual spawn; the wave's spawn event carries the true start time.
    if (registered?.startedAt != null && registered.startedAt > spawn.ts)
      return { ...registered, startedAt: spawn.ts };
    return registered ?? pendingChildSession(spawn, live);
  });
}

// Every subagent this session has spawned, whether or not the store has caught
// up. The feed card and the context panel must list the same agents at the same
// moment, and the store only registers a background Task once its provider
// session id is observed — which can lag the whole run — so both surfaces derive
// their rows from the spawn events and let registration fill the detail in.
export function spawnedChildSessions(
  transcript: readonly TranscriptEvent[],
  childSessions: readonly ChildSessionInfo[],
  live = false,
): ChildSessionInfo[] {
  const spawns = new Map<string, TranscriptEvent>();
  for (const event of transcript) {
    if (event.kind !== 'tool_call' || !isChildSessionTool(event.toolName, event.toolArgs)) continue;
    const key = event.toolUseId ?? event.id;
    const merged = spawns.get(key);
    spawns.set(key, merged ? mergeChildSessionSpawn(merged, event) : event);
  }
  const resolved = resolveWaveSessions([...spawns.values()], childSessions, live);
  const seen = new Set(resolved.map((child) => child.childSessionId));
  // A registered child whose spawn scrolled out of the loaded transcript window
  // (paged or compacted history) still belongs to the session.
  return [...resolved, ...childSessions.filter((child) => !seen.has(child.childSessionId))];
}

// A placeholder's childSessionId is replaced by the real one when the store
// registers the session, but its spawn link never changes; keying rows by the
// link keeps a row — and its creature avatar — identical across that swap.
export function childSessionKey(child: ChildSessionInfo): string {
  return child.spawnLink?.kind === 'tool-use' ? child.spawnLink.id : child.childSessionId;
}

const STATUS_PRIORITY: Record<ChildStatus, number> = {
  running: 0,
  pending: 1,
  paused: 2,
  completed: 3,
};

export type NamedChildSession = { child: ChildSessionInfo; name: string; key: string };

// Panel display order: whatever is still working sits on top, so a live agent is
// never pushed behind the fold by agents that already finished.
export function workingFirstChildSessions(
  childSessions: readonly ChildSessionInfo[],
): NamedChildSession[] {
  // Fallback names are numbered from spawn order, so reordering by status must
  // not renumber anyone: "Worker 2" stays Worker 2 when Worker 1 finishes.
  return orderedChildSessions(childSessions)
    .map((child, index) => ({
      child,
      name: childSessionLabel(child, index),
      key: childSessionKey(child),
    }))
    .sort((a, b) => STATUS_PRIORITY[a.child.status] - STATUS_PRIORITY[b.child.status]);
}

// Placeholder ids carry this prefix; unresolved spawns can't be opened.
export function isPendingChildPlaceholder(
  child: Pick<ChildSessionInfo, 'childSessionId'>,
): boolean {
  return child.childSessionId.startsWith('pending-');
}

function pendingChildSession(spawn: ChildSessionSpawnRef, live: boolean): ChildSessionInfo {
  const toolUseId = spawn.toolUseId ?? spawn.id;
  const info = childSessionInfo(spawn.toolArgs);
  return {
    parentAppSessionId: spawn.appSessionId,
    childSessionId: `pending-${toolUseId}`,
    role: 'worker',
    // An issued spawn is working: its store record can lag the entire run,
    // because a background Task only registers once its provider session id is
    // observed. The tool call's own end says nothing (a background Task
    // acknowledges its launch immediately), so endTs only settles a replayed
    // spawn, after its turn is over.
    status: live ? 'running' : spawn.endTs ? 'completed' : 'pending',
    label: info.label ?? 'Subagent',
    prompt: info.description,
    modelId: '',
    spawnLink: { kind: 'tool-use', id: toolUseId },
    transcriptAvailable: false,
    startedAt: spawn.ts,
  };
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
    // Autonomous subagents never open a runtime, so runtime availability must
    // not demote a running child to "paused"; the store status is authoritative.
    status: childSession.status,
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
