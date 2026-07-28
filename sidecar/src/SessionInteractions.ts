import {
  DroidInteractionMode,
  type AskUserHandler,
  type AskUserRequestParams,
  type AskUserResult,
  type PermissionHandler,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';

import type { FactorySession } from './DroidRuntime.js';
import { classifyPermission, confirmationType, permissionSignature } from './normalize.js';
import {
  isAlwaysOutcome,
  isApprovalOutcome,
  normalizePermissionOutcome,
} from './permissionOutcomes.js';
import type { PermissionKind, ServerEvent, SessionSummary } from './protocol.js';
import { errMsg } from './sessionHelpers.js';

interface PendingPermission {
  resolve: (result: RequestPermissionHandlerResult) => void;
  kind: PermissionKind;
  signature?: string;
}

interface InteractionScope {
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, (result: AskUserResult) => void>;
  permissionGrants: Set<string>;
}

export interface InteractionLiveSession {
  summary: SessionSummary;
  session: Pick<FactorySession, 'updateSettings'>;
}

type InteractionError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface SessionInteractionsDependencies {
  getLiveSession: (id: string) => InteractionLiveSession | undefined;
  updateSummary: (id: string, patch: Partial<SessionSummary>) => void;
  emit: (event: ServerEvent) => void;
  emitError: (error: InteractionError) => void;
}

let requestSequence = 0;
const defaultNextRequestId = () =>
  `req-${Date.now().toString(36)}-${(requestSequence++).toString(36)}`;

export class SessionInteractions {
  private readonly scopes = new Map<string, InteractionScope>();

  constructor(private readonly dependencies: SessionInteractionsDependencies) {}

  makePermissionHandler(ref: { id: string }): PermissionHandler {
    return (params: RequestPermissionRequestParams) =>
      new Promise<RequestPermissionHandlerResult>((resolve) => {
        const liveSession = this.dependencies.getLiveSession(ref.id);
        const requestId = defaultNextRequestId();
        const type = confirmationType(params);
        const request = classifyPermission(ref.id, requestId, params);
        const signature = permissionSignature(params);
        const scope = liveSession ? this.scope(liveSession.summary.appSessionId) : undefined;
        if (scope && signature && scope.permissionGrants.has(signature)) {
          resolve(normalizePermissionOutcome('proceed_always'));
          return;
        }
        if (liveSession && scope) {
          scope.pendingPermissions.set(requestId, {
            resolve,
            kind: request.kind,
            ...(signature ? { signature } : {}),
          });
          if (type === 'propose_mission') {
            this.dependencies.updateSummary(ref.id, {
              phase: 'awaiting_plan_approval',
              proposal: request.detail,
            });
          } else if (type === 'start_mission_run') {
            this.dependencies.updateSummary(ref.id, { phase: 'awaiting_run_start' });
          }
        }
        this.dependencies.emit({ type: 'approval.requested', request });
      });
  }

  makeAskUserHandler(ref: { id: string }): AskUserHandler {
    return (params: AskUserRequestParams) =>
      new Promise<AskUserResult>((resolve) => {
        const liveSession = this.dependencies.getLiveSession(ref.id);
        const requestId = defaultNextRequestId();
        const runtimeParams: {
          questions?: { index: number; question: string; options?: string[] }[];
        } = params;
        const questions = (runtimeParams.questions ?? []).map((question) => ({
          index: question.index,
          question: question.question,
          options: question.options ?? [],
        }));
        if (liveSession) {
          this.scope(liveSession.summary.appSessionId).pendingQuestions.set(requestId, resolve);
        }
        this.dependencies.emit({
          type: 'question.requested',
          question: { appSessionId: ref.id, requestId, questions },
        });
      });
  }

  async respondToApproval(appSessionId: string, requestId: string, outcome: string): Promise<void> {
    const liveSession = this.dependencies.getLiveSession(appSessionId);
    if (!liveSession) return;
    const scope = this.scopes.get(liveSession.summary.appSessionId);
    const pending = scope?.pendingPermissions.get(requestId);
    if (!scope || !pending) return;
    scope.pendingPermissions.delete(requestId);
    let normalized: RequestPermissionHandlerResult;
    try {
      normalized = normalizePermissionOutcome(outcome);
    } catch (error) {
      this.dependencies.emitError({
        code: 'permission.invalid_outcome',
        appSessionId,
        message: errMsg(error),
      });
      normalized = normalizePermissionOutcome('cancel');
    }
    if (pending.signature && isAlwaysOutcome(outcome)) {
      scope.permissionGrants.add(pending.signature);
    }
    if (pending.kind === 'spec' && isApprovalOutcome(normalized)) {
      await this.prepareSpecExitForRun(liveSession);
    }
    pending.resolve(normalized);
  }

  respondToQuestion(
    appSessionId: string,
    requestId: string,
    cancelled: boolean,
    answers: { index: number; question: string; answer: string }[],
  ): void {
    const liveSession = this.dependencies.getLiveSession(appSessionId);
    if (!liveSession) return;
    const scope = this.scopes.get(liveSession.summary.appSessionId);
    const resolve = scope?.pendingQuestions.get(requestId);
    if (!scope || !resolve) return;
    scope.pendingQuestions.delete(requestId);
    resolve({ cancelled, answers });
  }

  forgetSession(appSessionId: string): void {
    this.scopes.delete(appSessionId);
  }

  private scope(appSessionId: string): InteractionScope {
    const existing = this.scopes.get(appSessionId);
    if (existing) return existing;
    const created: InteractionScope = {
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      permissionGrants: new Set(),
    };
    this.scopes.set(appSessionId, created);
    return created;
  }

  private async prepareSpecExitForRun(liveSession: InteractionLiveSession): Promise<void> {
    const appSessionId = liveSession.summary.appSessionId;
    this.dependencies.updateSummary(appSessionId, {
      interactionMode: 'auto',
      phase: 'running',
    });
    try {
      await liveSession.session.updateSettings({
        interactionMode: DroidInteractionMode.Auto,
      });
    } catch (error) {
      this.dependencies.emitError({
        code: 'spec.exit_failed',
        appSessionId,
        message: `Could not switch spec session to Auto before run: ${errMsg(error)}`,
      });
    }
  }
}
