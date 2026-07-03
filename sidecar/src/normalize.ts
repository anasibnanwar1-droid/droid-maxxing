// Converts @factory/droid-sdk stream events into bridge protocol shapes.
import type {
  DroidStreamEvent,
  MissionFeature,
  ProgressLogEntry,
  RequestPermissionRequestParams,
} from '@factory/droid-sdk';
import { convertNotificationToStreamMessage } from '@factory/droid-sdk';
import type {
  AgentRole,
  BridgeFeature,
  PermissionKind,
  PermissionRequest,
  ProgressEntry,
  TranscriptEvent,
} from './protocol.js';

let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function mapFeature(f: MissionFeature): BridgeFeature {
  return {
    id: f.id,
    description: f.description,
    status: f.status as BridgeFeature['status'],
    skillName: f.skillName,
    preconditions: f.preconditions ?? [],
    expectedBehavior: f.expectedBehavior ?? [],
    verificationSteps: (f as { verificationSteps?: string[] }).verificationSteps ?? [],
    fulfills: f.fulfills,
    milestone: f.milestone,
    workerSessionIds: f.workerSessionIds,
    currentWorkerSessionId: f.currentWorkerSessionId ?? null,
    completedWorkerSessionId: f.completedWorkerSessionId ?? null,
  };
}

export function mapProgress(entries: ProgressLogEntry[]): ProgressEntry[] {
  return entries.map((e) => {
    const any = e as Record<string, unknown>;
    return {
      type: String(any.type ?? 'entry'),
      timestamp: String(any.timestamp ?? new Date().toISOString()),
      title: typeof any.title === 'string' ? any.title : undefined,
      message:
        typeof any.message === 'string'
          ? any.message
          : typeof any.summary === 'string'
            ? (any.summary as string)
            : undefined,
      featureId: typeof any.featureId === 'string' ? (any.featureId as string) : undefined,
      workerSessionId:
        typeof any.workerSessionId === 'string' ? (any.workerSessionId as string) : undefined,
    };
  });
}

function transcript(
  missionId: string,
  agentSessionId: string,
  role: AgentRole,
  kind: TranscriptEvent['kind'],
  extra: Partial<TranscriptEvent>,
): TranscriptEvent {
  return { id: nextId(), missionId, agentSessionId, role, ts: Date.now(), kind, ...extra };
}

export interface NormalizedEvent {
  transcript?: TranscriptEvent;
  features?: BridgeFeature[];
  progress?: ProgressEntry[];
  missionState?: string;
  worker?: { event: 'started' | 'completed'; workerSessionId: string; exitCode?: number };
  subagent?: {
    sessionId?: string;
    toolUseId?: string;
    label?: string;
    prompt?: string;
    done?: boolean;
  };
  tokens?: { tokensIn: number; tokensOut: number; contextTokens: number };
  done?: boolean;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function taskPrompt(input: Record<string, unknown>): string | undefined {
  for (const key of ['prompt', 'task', 'instructions', 'message', 'description', 'input']) {
    const value = str(input[key]);
    if (value) return value;
  }
  return undefined;
}

function toolUseIdFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    const id = str(value);
    if (id) return id;
  }
  return undefined;
}

// The SDK subagent spawn is the `Task` tool. Match it as a whole word so
// unrelated tools whose names merely contain "task" (e.g. `create_task`) are
// never mistaken for a subagent.
const isTaskToolName = (name: unknown): boolean =>
  typeof name === 'string' && /\btask\b/i.test(name);

// A chat (non-mission) session spawns subagents via the Task tool; those surface
// as ToolProgress events carrying `subagentSessionId` plus a Task tool name/input.
function detectSubagent(
  toolName: unknown,
  input: Record<string, unknown>,
  sessionId: string | undefined,
  toolUseId: string | undefined,
): NormalizedEvent['subagent'] | undefined {
  const isTask =
    isTaskToolName(toolName) ||
    typeof input.subagent_type === 'string' ||
    typeof input.subagentType === 'string';
  if (!isTask && !sessionId) return undefined;
  const label =
    str(input.subagent_type) ??
    str(input.subagentType) ??
    str(input.description) ??
    (typeof toolName === 'string' ? toolName : undefined);
  return { sessionId, toolUseId, label, prompt: taskPrompt(input) };
}

// The orchestrator's Task tool_call carries the entire subagent prompt in its
// input. That prompt belongs in the subagent's own pane, not the main feed, so
// we keep only the lightweight label fields on the transcript copy.
function slimSubagentArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['subagent_type', 'subagentType', 'description']) {
    if (typeof input[key] === 'string') out[key] = input[key];
  }
  return out;
}

// Translate a single SDK stream event into zero-or-one normalized bridge updates.
export function normalizeStreamEvent(
  missionId: string,
  agentSessionId: string,
  role: AgentRole,
  ev: DroidStreamEvent,
): NormalizedEvent | null {
  const raw = ev as unknown as Record<string, unknown>;
  if (raw.type === 'token_usage_update' || raw.type === 'session_token_usage_changed') {
    const e = raw as Record<string, Record<string, unknown> | undefined>;
    const cumulative = e.inclusiveTokenUsage ?? e.tokenUsage ?? e;
    const context = e.lastCallTokenUsage ?? e.tokenUsage ?? e;
    const tokensIn =
      (Number(cumulative.inputTokens ?? 0) || 0) +
      (Number(cumulative.cacheReadTokens ?? 0) || 0) +
      (Number(cumulative.cacheCreationTokens ?? 0) || 0);
    const tokensOut = Number(cumulative.outputTokens ?? 0) || 0;
    const contextTokens =
      (Number(context.inputTokens ?? 0) || 0) + (Number(context.cacheReadTokens ?? 0) || 0);
    return { tokens: { tokensIn, tokensOut, contextTokens } };
  }

  // ToolProgress events nest the spawned subagent's session id under `update`.
  const update =
    raw.update && typeof raw.update === 'object'
      ? (raw.update as Record<string, unknown>)
      : undefined;
  const subagentSessionId = str(raw.subagentSessionId) ?? str(update?.subagentSessionId);
  const eventToolUseId = toolUseIdFrom(raw.toolUseId, update?.toolUseId);

  if (ev.type === 'tool_progress' || raw.type === 'tool_progress') {
    // The session id arrives here; the label was captured earlier on the Task tool_call,
    // so only forward a label if these params actually carry a specific subagent name.
    const params =
      update?.parameters && typeof update.parameters === 'object'
        ? (update.parameters as Record<string, unknown>)
        : {};
    const label = str(params.subagent_type) ?? str(params.subagentType);
    const prompt = taskPrompt(params);
    if (!subagentSessionId && !label && !prompt) return null;
    return { subagent: { sessionId: subagentSessionId, toolUseId: eventToolUseId, label, prompt } };
  }

  switch (ev.type) {
    case 'assistant_text_delta':
      return { transcript: transcript(missionId, agentSessionId, role, 'text', { text: ev.text }) };
    case 'thinking_text_delta':
      return {
        transcript: transcript(missionId, agentSessionId, role, 'thinking', { text: ev.text }),
      };
    case 'tool_call':
    case 'tool_call_delta': {
      const toolUse =
        (ev as { toolUse?: { id?: string; name?: string; input?: Record<string, unknown> } })
          .toolUse ?? {};
      const toolUseId = toolUseIdFrom(toolUse.id, eventToolUseId);
      const subagent = detectSubagent(
        toolUse.name,
        toolUse.input ?? {},
        subagentSessionId,
        toolUseId,
      );
      return {
        transcript: transcript(missionId, agentSessionId, role, 'tool_call', {
          toolName: toolUse.name,
          toolArgs: subagent ? slimSubagentArgs(toolUse.input ?? {}) : toolUse.input,
          // Stamp every tool_call with its stable id so the store/chat feed can
          // collapse the many streaming deltas of one call into a single event
          // (matching the replay path, which derives one block per tool-use).
          ...(toolUseId ? { toolUseId } : {}),
        }),
        ...(subagent ? { subagent } : {}),
      };
    }
    case 'tool_result': {
      const isTask = isTaskToolName(ev.toolName);
      const toolUseId = toolUseIdFrom((ev as { toolUseId?: string }).toolUseId, eventToolUseId);
      // A successful subagent Task result is just the subagent's output, so it
      // surfaces only as a completion signal and never leaks into the main feed.
      // A *failed* spawn must stay visible, so keep its error transcript.
      if (subagentSessionId || isTask) {
        const done = { subagent: { sessionId: subagentSessionId, toolUseId, done: true } };
        if (!ev.isError) return done;
        return {
          ...done,
          transcript: transcript(missionId, agentSessionId, role, 'tool_result', {
            toolName: ev.toolName,
            text: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
            isError: true,
          }),
        };
      }
      return {
        transcript: transcript(missionId, agentSessionId, role, 'tool_result', {
          toolName: ev.toolName,
          text: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
          isError: ev.isError,
          ...(toolUseId ? { toolUseId } : {}),
        }),
      };
    }
    case 'error':
      return {
        transcript: transcript(missionId, agentSessionId, role, 'error', {
          text: ev.message,
          isError: true,
        }),
      };
    case 'mission_features_changed':
      return { features: ev.features.map(mapFeature) };
    case 'mission_progress_entry':
      return { progress: mapProgress(ev.progressLog) };
    case 'mission_state_changed':
      return { missionState: ev.state };
    case 'mission_worker_started':
      return { worker: { event: 'started', workerSessionId: ev.workerSessionId } };
    case 'mission_worker_completed':
      return {
        worker: {
          event: 'completed',
          workerSessionId: ev.workerSessionId,
          exitCode: ev.exitCode,
        },
      };
    case 'result':
      return { done: true };
    default:
      if (subagentSessionId)
        return { subagent: { sessionId: subagentSessionId, toolUseId: eventToolUseId } };
      return null;
  }
}

// Daemon auto-compaction runs in place (same session id) and announces itself
// only through raw notifications: a `droid_working_state_changed` to
// `compacting_conversation` when it starts and a `session_compacted` when it
// finishes. Neither survives convertNotificationToStreamMessage as a usable
// stream event, so callers detect them here before the generic conversion.
export interface CompactionNotification {
  kind: 'started' | 'completed';
  removedCount: number;
}

export function extractCompactionNotification(
  notification: Record<string, unknown>,
): CompactionNotification | null {
  const raw = extractNotification(notification);
  if (!raw || typeof raw !== 'object') return null;
  const note = raw as Record<string, unknown>;
  if (note.type === 'droid_working_state_changed' && note.newState === 'compacting_conversation')
    return { kind: 'started', removedCount: 0 };
  if (note.type === 'session_compacted')
    return { kind: 'completed', removedCount: Number(note.removedCount ?? 0) || 0 };
  return null;
}

export function normalizeNotification(
  missionId: string,
  agentSessionId: string,
  role: AgentRole,
  notification: Record<string, unknown>,
): NormalizedEvent[] {
  const raw = extractNotification(notification);
  const converted = convertNotificationToStreamMessage(raw);
  const messages = Array.isArray(converted) ? converted : converted ? [converted] : [];
  return messages
    .map((message) =>
      normalizeStreamEvent(missionId, agentSessionId, role, message as DroidStreamEvent),
    )
    .filter((event): event is NormalizedEvent => event !== null);
}

function extractNotification(notification: Record<string, unknown>): unknown {
  const params =
    notification.params &&
    typeof notification.params === 'object' &&
    !Array.isArray(notification.params)
      ? (notification.params as Record<string, unknown>)
      : undefined;
  if (params && 'notification' in params) return params.notification;
  if ('notification' in notification) return notification.notification;
  return notification;
}

const PERMISSION_KIND: Record<string, PermissionKind> = {
  edit: 'edit',
  exec: 'exec',
  create: 'create',
  apply_patch: 'apply_patch',
  mcp_tool: 'mcp',
  exit_spec_mode: 'spec',
};

interface ConfirmationDetail {
  type?: string;
  [k: string]: unknown;
}

// Extract the primary confirmation detail. The Droid SDK shape is
// `params.toolUses[0].details`; older/alternate shapes used `confirmations` or a
// bare `confirmation`, which we still fall back to defensively.
function primaryConfirmation(params: RequestPermissionRequestParams): ConfirmationDetail {
  const p = params as unknown as Record<string, unknown>;
  const toolUses = p.toolUses as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(toolUses) && toolUses.length > 0) {
    const details = toolUses[0].details as ConfirmationDetail | undefined;
    if (details) return details;
  }
  const list = p.confirmations as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(list) && list.length > 0) {
    const item = list[0];
    return (item.confirmation as ConfirmationDetail) ?? (item as ConfirmationDetail);
  }
  return (p.confirmation as ConfirmationDetail) ?? {};
}

// The tool's actual call arguments live on the tool-use block, not the
// confirmation detail.
function primaryToolInput(params: RequestPermissionRequestParams): Record<string, unknown> {
  const p = params as unknown as Record<string, unknown>;
  const toolUses = p.toolUses as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(toolUses) && toolUses.length > 0) {
    const toolUse = toolUses[0].toolUse as Record<string, unknown> | undefined;
    const input = toolUse?.input;
    if (input && typeof input === 'object') return input as Record<string, unknown>;
  }
  return {};
}

// Build a readable summary of an MCP tool request: its arguments (so the user
// can see *what* it will do, e.g. the URL a browser tool will open) plus the
// declared impact level when present.
function mcpToolDetail(c: ConfirmationDetail, input: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    if (rendered === undefined || rendered === '' || rendered === '{}') continue;
    lines.push(`${key}: ${rendered}`);
  }
  if (c.impactLevel) lines.push(`Impact: ${c.impactLevel}`);
  return lines.join('\n');
}

export function classifyPermission(
  missionId: string,
  requestId: string,
  params: RequestPermissionRequestParams,
): PermissionRequest {
  const c = primaryConfirmation(params);
  const type = String(c.type ?? 'other');
  let title = 'Permission required';
  let detail = '';
  let plan: string | undefined;
  let options: string[] | undefined;
  let kind: PermissionKind = PERMISSION_KIND[type] ?? 'other';

  switch (type) {
    case 'exit_spec_mode':
      title = (c.title as string) ?? 'Plan ready for review';
      plan = (c.plan as string) ?? '';
      detail = plan;
      options = Array.isArray(c.optionNames) ? (c.optionNames as string[]) : undefined;
      kind = 'spec';
      break;
    case 'propose_mission':
      title = (c.title as string) ?? 'Mission plan proposed';
      plan = (c.proposal as string) ?? '';
      detail = plan;
      kind = 'mission_plan';
      break;
    case 'start_mission_run':
      title = 'Start mission run';
      detail = `Running missions: ${c.runningMissionCount ?? 0}`;
      kind = 'other';
      break;
    case 'exec':
      title = 'Run command';
      detail = (c.command as string) ?? JSON.stringify(c);
      break;
    case 'edit':
    case 'create':
      title = type === 'create' ? 'Create file' : 'Edit file';
      detail = (c.filePath as string) ?? (c.fileName as string) ?? '';
      break;
    case 'apply_patch':
      title = 'Apply patch';
      detail = (c.fileName as string) ?? (c.filePath as string) ?? '';
      break;
    case 'mcp_tool': {
      const rawTool = typeof c.toolName === 'string' ? c.toolName : '';
      // MCP tools are namespaced as `server___tool`; split for a readable label.
      const [splitServer, splitTool] = rawTool.includes('___')
        ? [rawTool.slice(0, rawTool.indexOf('___')), rawTool.slice(rawTool.indexOf('___') + 3)]
        : ['', rawTool];
      const serverName =
        typeof c.serverName === 'string' && c.serverName ? c.serverName : splitServer;
      const toolName = splitTool;
      title = toolName
        ? serverName
          ? `${serverName} · ${toolName}`
          : toolName
        : serverName
          ? `${serverName} tool`
          : 'External tool';
      detail = mcpToolDetail(c, primaryToolInput(params));
      break;
    }
    default:
      detail = JSON.stringify(c);
  }

  return { missionId, requestId, kind, title, detail, plan, options, raw: params };
}

export function confirmationType(params: RequestPermissionRequestParams): string {
  return String(primaryConfirmation(params).type ?? 'other');
}

// Stable key identifying "the same action" so an app-level allowlist can honor
// "Always allow" even when the underlying agent does not persist the grant.
// An empty string means the request is not eligible for always-allow caching.
export function permissionSignature(params: RequestPermissionRequestParams): string {
  const c = primaryConfirmation(params);
  const type = String(c.type ?? 'other');
  switch (type) {
    case 'exec':
      return `exec::${String(c.command ?? '')}`;
    case 'mcp_tool':
      return `mcp::${String(c.serverName ?? '')}::${String(c.toolName ?? '')}`;
    case 'edit':
    case 'create':
    case 'apply_patch': {
      // Scope file-write grants to the specific path so "Always allow" cannot
      // bypass prompts for unrelated files. No identifiable path => ineligible.
      const path =
        typeof c.filePath === 'string' && c.filePath
          ? c.filePath
          : typeof c.fileName === 'string' && c.fileName
            ? c.fileName
            : '';
      return path ? `${type}::${path}` : '';
    }
    default:
      return '';
  }
}
