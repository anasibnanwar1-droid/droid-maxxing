import type { ServerEvent, SessionSummary } from './protocol.js';
import type { PrimaryPromptPriority, PrimaryPromptQueue } from './PrimaryPromptQueue.js';
import { errMsg } from './sessionHelpers.js';

type ContextPreflightSummary = Pick<
  SessionSummary,
  | 'appSessionId'
  | 'sessionPurpose'
  | 'contextTokens'
  | 'contextRemainingTokens'
  | 'contextAccuracy'
  | 'maxContextTokens'
  | 'compactionTokenLimit'
>;

export type PrimaryTurnPreflightDecision = 'ready' | 'compact' | 'blocked';

type PreflightError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

interface PreflightSession {
  summary: ContextPreflightSummary & Pick<SessionSummary, 'providerSessionId'>;
  streaming: boolean;
  compacting?: boolean;
  promptQueue: Pick<PrimaryPromptQueue, 'enqueue' | 'protectHead'>;
}

interface PreflightActions {
  compactBeforeSend: (appSessionId: string) => Promise<void>;
  updateQueuedSends: () => void;
  emitStatus: (appSessionId: string, text: string) => void;
  emitError: (error: PreflightError) => void;
}

export type PreflightSteerDecision = { handled: false } | { handled: true; status?: string };

export const AUTO_COMPACTION_UNAVAILABLE_MESSAGE =
  'Automatic compaction is unavailable. DROIDEX will compact before sending into an exhausted context.';

export const CONTEXT_EXHAUSTED_MESSAGE =
  'This conversation is out of context and compaction could not free enough space. Your messages are still queued; compact again or start a new thread.';

/**
 * Exact context telemetry is authoritative. The configured daemon threshold is
 * the preferred boundary; a completely full model window is the fail-safe when
 * automatic compaction could not be armed.
 */
export function needsPrimaryTurnPreflightCompaction(summary: ContextPreflightSummary): boolean {
  if (
    summary.sessionPurpose === 'mission-control' ||
    summary.contextAccuracy !== 'exact' ||
    summary.contextTokens <= 0
  ) {
    return false;
  }
  if (
    summary.compactionTokenLimit !== undefined &&
    summary.contextTokens >= summary.compactionTokenLimit
  ) {
    return true;
  }
  if (summary.contextRemainingTokens !== undefined && summary.contextRemainingTokens <= 0) {
    return true;
  }
  return (
    summary.maxContextTokens !== undefined && summary.contextTokens >= summary.maxContextTokens
  );
}

/**
 * Remembers the exact exhausted context that already received one compaction
 * attempt. Every queued prompt shares that context, so a no-op or failed
 * compaction is blocked once instead of recursively compacting each message.
 */
export class PrimaryTurnPreflight {
  private readonly attemptedContexts = new Map<string, string>();

  queuePrompt(
    session: PreflightSession,
    text: string,
    priority: PrimaryPromptPriority,
  ): PreflightSteerDecision {
    const appSessionId = session.summary.appSessionId;
    if (this.isBlocked(session.summary)) {
      session.promptQueue.enqueue(text, priority);
      return {
        handled: true,
        status: 'Context is full. This message is queued until compaction succeeds.',
      };
    }
    if (session.streaming && needsPrimaryTurnPreflightCompaction(session.summary)) {
      session.promptQueue.enqueue(text, priority);
      return {
        handled: true,
        status: 'Context is full. This follow-up will be delivered after compaction.',
      };
    }
    if (session.compacting && this.attemptedContexts.has(appSessionId)) {
      session.promptQueue.enqueue(text, priority);
      return { handled: true };
    }
    return { handled: false };
  }

  intercept(
    session: PreflightSession,
    prompt: string,
    priority: PrimaryPromptPriority,
    actions: PreflightActions,
  ): false | Promise<true> {
    const appSessionId = session.summary.appSessionId;
    const decision = this.decide(session.summary);
    if (decision === 'ready') return false;
    if (decision === 'compact') {
      session.promptQueue.protectHead({ text: prompt, priority });
      actions.updateQueuedSends();
      return this.compact(appSessionId, session, actions);
    }

    session.promptQueue.protectHead({ text: prompt, priority });
    actions.updateQueuedSends();
    actions.emitStatus(appSessionId, CONTEXT_EXHAUSTED_MESSAGE);
    actions.emitError({
      code: 'session.context_exhausted',
      appSessionId,
      providerSessionId: session.summary.providerSessionId,
      message: CONTEXT_EXHAUSTED_MESSAGE,
      recoverable: true,
    });
    return Promise.resolve(true);
  }

  decide(summary: ContextPreflightSummary): PrimaryTurnPreflightDecision {
    if (!needsPrimaryTurnPreflightCompaction(summary)) {
      this.clear(summary.appSessionId);
      return 'ready';
    }
    const contextKey = contextAttemptKey(summary);
    if (this.attemptedContexts.get(summary.appSessionId) === contextKey) return 'blocked';

    this.attemptedContexts.set(summary.appSessionId, contextKey);
    return 'compact';
  }

  isBlocked(summary: ContextPreflightSummary): boolean {
    return (
      needsPrimaryTurnPreflightCompaction(summary) &&
      this.attemptedContexts.get(summary.appSessionId) === contextAttemptKey(summary)
    );
  }

  clear(appSessionId: string): void {
    this.attemptedContexts.delete(appSessionId);
  }

  private async compact(
    appSessionId: string,
    session: PreflightSession,
    actions: PreflightActions,
  ): Promise<true> {
    try {
      await actions.compactBeforeSend(appSessionId);
    } catch (error) {
      actions.updateQueuedSends();
      actions.emitError({
        code: 'session.preflight_compaction_failed',
        appSessionId,
        providerSessionId: session.summary.providerSessionId,
        message: `Could not compact before sending: ${errMsg(error)}. Your messages remain queued.`,
        recoverable: true,
      });
    }
    return true;
  }
}

function contextAttemptKey(summary: ContextPreflightSummary): string {
  return [
    summary.contextTokens,
    summary.contextRemainingTokens ?? '',
    summary.maxContextTokens ?? '',
    summary.compactionTokenLimit ?? '',
  ].join(':');
}
