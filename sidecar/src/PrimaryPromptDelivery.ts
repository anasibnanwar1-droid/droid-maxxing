import type { ServerEvent } from './protocol.js';
import type { PrimaryPromptPriority, PrimaryQueuedPrompt } from './PrimaryPromptQueue.js';
import { PrimaryTurnPreflight } from './PrimaryTurnPreflight.js';
import type { SessionRegistry } from './SessionRegistry.js';
import type { LiveSession } from './SessionLifecycle.js';
import { errMsg } from './sessionHelpers.js';

type PromptDeliveryError = Omit<Extract<ServerEvent, { type: 'error' }>, 'type'>;

export interface PrimaryTurnSettlement {
  promise: Promise<void>;
  resolve: () => void;
}

interface PrimaryPromptDeliveryDependencies {
  registry: Pick<SessionRegistry<LiveSession>, 'getLive' | 'updateSummary'>;
  runPrimaryTurn: (
    liveSession: LiveSession,
    prompt: string,
    abortSignal: AbortSignal,
  ) => Promise<void>;
  compactBeforeSend: (appSessionId: string) => Promise<void>;
  afterAutomaticCompactionTurn: (liveSession: LiveSession) => void;
  redeliverQueuedPrompts: (appSessionId: string, prompts: PrimaryQueuedPrompt[]) => Promise<void>;
  isShutdownStarted: () => boolean;
  emitStatus: (appSessionId: string, text: string) => void;
  emitError: (error: PromptDeliveryError) => void;
}

/**
 * Owns admission and delivery for primary-session prompts: queue priority,
 * exact-context preflight, active-turn state, and post-turn draining.
 */
export class PrimaryPromptDelivery {
  private readonly preflight = new PrimaryTurnPreflight();

  constructor(private readonly dependencies: PrimaryPromptDeliveryDependencies) {}

  async send(liveSession: LiveSession, text: string): Promise<void> {
    const preflight = this.preflight.queuePrompt(liveSession, text, 'queue');
    if (preflight.handled) {
      this.updateQueuedSends(liveSession);
      if (preflight.status) {
        this.dependencies.emitStatus(liveSession.summary.appSessionId, preflight.status);
      }
      return;
    }
    if (this.isBusy(liveSession)) {
      liveSession.promptQueue.enqueue(text, 'queue');
      this.updateQueuedSends(liveSession);
      return;
    }
    if (liveSession.promptQueue.size > 0) {
      liveSession.promptQueue.enqueue(text, 'queue');
      await this.driveNextPending(liveSession);
      return;
    }
    await this.drive(liveSession.summary.appSessionId, text, 'queue');
  }

  async sendNow(liveSession: LiveSession, text: string): Promise<void> {
    const preflight = this.preflight.queuePrompt(liveSession, text, 'steer');
    if (preflight.handled) {
      this.updateQueuedSends(liveSession);
      if (preflight.status) {
        this.dependencies.emitStatus(liveSession.summary.appSessionId, preflight.status);
      }
      return;
    }
    if (!this.isBusy(liveSession)) {
      if (liveSession.promptQueue.size > 0) {
        liveSession.promptQueue.enqueue(text, 'steer');
        await this.driveNextPending(liveSession);
      } else {
        await this.drive(liveSession.summary.appSessionId, text, 'steer');
      }
      return;
    }
    if (liveSession.compacting || liveSession.autoCompacting || liveSession.interrupting) {
      liveSession.promptQueue.enqueue(text, 'steer');
      this.updateQueuedSends(liveSession);
      return;
    }

    const appSessionId = liveSession.summary.appSessionId;
    this.dependencies.emitStatus(appSessionId, 'Steering at the next safe boundary...');
    try {
      await liveSession.session.send(text);
    } catch (error) {
      if (
        this.dependencies.registry.getLive(appSessionId) !== liveSession ||
        this.dependencies.isShutdownStarted()
      ) {
        return;
      }
      this.dependencies.emitError({
        code: 'session.send_now_failed',
        appSessionId,
        message: `Could not steer the active session: ${errMsg(error)}`,
      });
    }
  }

  startInBackground(liveSession: LiveSession, prompt: string): void {
    this.driveInBackground(liveSession.summary.appSessionId, prompt, 'queue');
  }

  async settle(liveSession: LiveSession): Promise<void> {
    if (
      liveSession.closeMode ||
      liveSession.streaming ||
      liveSession.compacting ||
      liveSession.autoCompacting ||
      liveSession.interrupting
    ) {
      return;
    }
    await this.driveNextPending(liveSession);
  }

  discard(liveSession: LiveSession): void {
    liveSession.promptQueue.clear();
    this.preflight.clear(liveSession.summary.appSessionId);
  }

  drain(liveSession: LiveSession): PrimaryQueuedPrompt[] {
    return liveSession.promptQueue.drain();
  }

  private async drive(
    appSessionId: string,
    prompt: string,
    priority: PrimaryPromptPriority,
  ): Promise<void> {
    const d = this.dependencies;
    const liveSession = d.registry.getLive(appSessionId);
    if (!liveSession || liveSession.closeMode || d.isShutdownStarted()) return;
    const stableAppSessionId = liveSession.summary.appSessionId;
    const preflight = this.preflight.intercept(liveSession, prompt, priority, {
      compactBeforeSend: d.compactBeforeSend,
      updateQueuedSends: () => {
        this.updateQueuedSends(liveSession);
      },
      emitStatus: d.emitStatus,
      emitError: d.emitError,
    });
    if (preflight) {
      await preflight;
      return;
    }

    const turnAbortController = new AbortController();
    const turnSettlement = createTurnSettlement();
    liveSession.turnAbortController = turnAbortController;
    liveSession.turnSettlement = turnSettlement;
    try {
      liveSession.streaming = true;
      d.registry.updateSummary(stableAppSessionId, {
        phase: liveSession.summary.sessionPurpose === 'mission-control' ? 'planning' : 'running',
        streaming: true,
        queuedSends: liveSession.promptQueue.size,
      });
      await d.runPrimaryTurn(liveSession, prompt, turnAbortController.signal);
    } finally {
      try {
        if (liveSession.turnAbortController === turnAbortController) {
          delete liveSession.turnAbortController;
          delete liveSession.turnSettlement;
        }
        liveSession.streaming = false;
        if (d.isShutdownStarted() || this.shouldDiscardPendingPrompts(liveSession)) {
          liveSession.promptQueue.clear();
        } else if (!d.registry.getLive(stableAppSessionId)) {
          const queued = liveSession.promptQueue.drain();
          if (queued.length > 0) {
            void d.redeliverQueuedPrompts(stableAppSessionId, queued);
          }
        } else if (liveSession.autoCompacting) {
          d.afterAutomaticCompactionTurn(liveSession);
          this.updateQueuedSends(liveSession);
        } else if (liveSession.interrupting) {
          this.updateQueuedSends(liveSession);
        } else {
          const next = liveSession.promptQueue.take();
          this.updateQueuedSends(liveSession);
          if (next) this.driveInBackground(stableAppSessionId, next.text, next.priority);
        }
      } finally {
        turnSettlement.resolve();
      }
    }
  }

  private driveInBackground(
    appSessionId: string,
    prompt: string,
    priority: PrimaryPromptPriority,
  ): void {
    void this.drive(appSessionId, prompt, priority).catch((error: unknown) => {
      if (!this.dependencies.isShutdownStarted()) {
        this.dependencies.emitError({ appSessionId, message: errMsg(error) });
      }
    });
  }

  private async driveNextPending(liveSession: LiveSession): Promise<void> {
    const next = liveSession.promptQueue.take();
    this.updateQueuedSends(liveSession);
    if (next) await this.drive(liveSession.summary.appSessionId, next.text, next.priority);
  }

  private updateQueuedSends(liveSession: LiveSession): void {
    this.dependencies.registry.updateSummary(liveSession.summary.appSessionId, {
      streaming: liveSession.streaming,
      queuedSends: liveSession.promptQueue.size,
    });
  }

  private isBusy(liveSession: LiveSession): boolean {
    return [
      liveSession.streaming,
      liveSession.compacting,
      liveSession.autoCompacting,
      liveSession.interrupting,
    ].some((state) => state === true);
  }

  private shouldDiscardPendingPrompts(liveSession: LiveSession): boolean {
    return liveSession.closeMode === 'discard-pending';
  }
}

function createTurnSettlement(): PrimaryTurnSettlement {
  let settle = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}
