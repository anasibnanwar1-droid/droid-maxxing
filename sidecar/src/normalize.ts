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
  subagent?: { sessionId?: string; label?: string; done?: boolean };
  tokens?: { tokensIn: number; tokensOut: number; contextTokens: number };
  done?: boolean;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

// A chat (non-mission) session spawns subagents via the Task tool; those surface
// as ToolProgress events carrying `subagentSessionId` plus a Task tool name/input.
function detectSubagent(
  toolName: unknown,
  input: Record<string, unknown>,
  sessionId: string | undefined,
): NormalizedEvent['subagent'] | undefined {
  const isTask =
    (typeof toolName === 'string' && /task/i.test(toolName)) ||
    typeof input.subagent_type === 'string' ||
    typeof input.subagentType === 'string';
  if (!isTask && !sessionId) return undefined;
  const label =
    str(input.subagent_type) ??
    str(input.subagentType) ??
    str(input.description) ??
    (typeof toolName === 'string' ? toolName : undefined);
  return { sessionId, label };
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
      (Number(context.inputTokens ?? 0) || 0) +
      (Number(context.cacheReadTokens ?? 0) || 0);
    return { tokens: { tokensIn, tokensOut, contextTokens } };
  }

  // ToolProgress events nest the spawned subagent's session id under `update`.
  const update = raw.update && typeof raw.update === 'object' ? (raw.update as Record<string, unknown>) : undefined;
  const subagentSessionId = str(raw.subagentSessionId) ?? str(update?.subagentSessionId);

  if (ev.type === 'tool_progress' || raw.type === 'tool_progress') {
    // The session id arrives here; the label was captured earlier on the Task tool_call,
    // so only forward a label if these params actually carry a specific subagent name.
    const params = update?.parameters && typeof update.parameters === 'object' ? (update.parameters as Record<string, unknown>) : {};
    const label = str(params.subagent_type) ?? str(params.subagentType);
    if (!subagentSessionId && !label) return null;
    return { subagent: { sessionId: subagentSessionId, label } };
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
      const toolUse = (ev as { toolUse?: { name?: string; input?: Record<string, unknown> } }).toolUse ?? {};
      const subagent = detectSubagent(toolUse.name, toolUse.input ?? {}, subagentSessionId);
      return {
        transcript: transcript(missionId, agentSessionId, role, 'tool_call', {
          toolName: toolUse.name,
          toolArgs: toolUse.input,
        }),
        ...(subagent ? { subagent } : {}),
      };
    }
    case 'tool_result': {
      const isTask = typeof ev.toolName === 'string' && /task/i.test(ev.toolName);
      return {
        transcript: transcript(missionId, agentSessionId, role, 'tool_result', {
          toolName: ev.toolName,
          text: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
          isError: ev.isError,
        }),
        ...(subagentSessionId || isTask ? { subagent: { sessionId: subagentSessionId, done: true } } : {}),
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
      if (subagentSessionId) return { subagent: { sessionId: subagentSessionId } };
      return null;
  }
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
    .map((message) => normalizeStreamEvent(missionId, agentSessionId, role, message as DroidStreamEvent))
    .filter((event): event is NormalizedEvent => event !== null);
}

function extractNotification(notification: Record<string, unknown>): unknown {
  const params = notification.params && typeof notification.params === 'object' && !Array.isArray(notification.params)
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

// Extract the primary confirmation detail regardless of params shape variations.
function primaryConfirmation(params: RequestPermissionRequestParams): ConfirmationDetail {
  const p = params as unknown as Record<string, unknown>;
  const list = p.confirmations as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(list) && list.length > 0) {
    const item = list[0];
    return (item.confirmation as ConfirmationDetail) ?? (item as ConfirmationDetail);
  }
  return (p.confirmation as ConfirmationDetail) ?? {};
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
      detail = (c.proposal as string) ?? '';
      kind = 'other';
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
    case 'mcp_tool':
      title = `MCP tool: ${c.toolName ?? ''}`;
      detail = `Impact: ${c.impactLevel ?? 'unknown'}`;
      break;
    default:
      detail = JSON.stringify(c);
  }

  return { missionId, requestId, kind, title, detail, plan, options, raw: params };
}

export function confirmationType(params: RequestPermissionRequestParams): string {
  return String(primaryConfirmation(params).type ?? 'other');
}
