import type { DroidStreamEvent } from '@factory/droid-sdk';

import { normalizeNotification, normalizeStreamEvent, type NormalizedEvent } from './normalize.js';
import type { SessionRole, TranscriptEvent } from './protocol.js';

export type NormalizedSideEffects = Omit<NormalizedEvent, 'transcript' | 'done' | 'tokens'>;
export type NormalizedTokenUsage = NonNullable<NormalizedEvent['tokens']>;

export interface SessionEventFlowDependencies {
  appendTranscript: (event: TranscriptEvent) => void;
  applySideEffects: (appSessionId: string, sideEffects: NormalizedSideEffects) => void;
  recordUsage: (
    appSessionId: string,
    sourceProviderSessionId: string,
    usage: NormalizedTokenUsage,
  ) => void;
}

const POST_TERMINAL_GENERATION_KINDS = new Set(['text', 'thinking', 'tool_call', 'tool_result']);

export class SessionEventFlow {
  private readonly terminalSources = new Map<string, Set<string>>();

  constructor(private readonly dependencies: SessionEventFlowDependencies) {}

  beginTurn(appSessionId: string, sourceProviderSessionId: string): void {
    this.terminalSources.get(appSessionId)?.delete(sourceProviderSessionId);
  }

  applyStreamEvent(
    appSessionId: string,
    sourceProviderSessionId: string,
    role: SessionRole,
    event: DroidStreamEvent,
    childSessionId?: string,
  ): void {
    const normalized = normalizeStreamEvent(appSessionId, sourceProviderSessionId, role, event);
    if (normalized) {
      this.applyNormalized(appSessionId, sourceProviderSessionId, normalized, childSessionId);
    }
  }

  applyNotification(
    appSessionId: string,
    sourceProviderSessionId: string,
    role: SessionRole,
    notification: Record<string, unknown>,
    childSessionId?: string,
  ): void {
    for (const normalized of normalizeNotification(
      appSessionId,
      sourceProviderSessionId,
      role,
      notification,
    )) {
      this.applyNormalized(appSessionId, sourceProviderSessionId, normalized, childSessionId);
    }
  }

  forgetSession(appSessionId: string): void {
    this.terminalSources.delete(appSessionId);
  }

  private applyNormalized(
    appSessionId: string,
    sourceProviderSessionId: string,
    normalized: NormalizedEvent,
    childSessionId?: string,
  ): void {
    if (normalized.done) {
      this.terminalScope(appSessionId).add(sourceProviderSessionId);
      return;
    }

    const terminal = this.terminalSources.get(appSessionId)?.has(sourceProviderSessionId);
    const transcript =
      terminal && isPostTerminalGeneration(normalized.transcript)
        ? undefined
        : normalized.transcript;
    if (transcript)
      this.dependencies.appendTranscript(
        childSessionId ? { ...transcript, sourceSessionId: childSessionId } : transcript,
      );
    if (normalized.tokens)
      this.dependencies.recordUsage(appSessionId, sourceProviderSessionId, normalized.tokens);

    const sideEffects = normalizedSideEffects(normalized);
    if (hasSideEffects(sideEffects)) {
      this.dependencies.applySideEffects(appSessionId, sideEffects);
    }
  }

  private terminalScope(appSessionId: string): Set<string> {
    const existing = this.terminalSources.get(appSessionId);
    if (existing) return existing;
    const created = new Set<string>();
    this.terminalSources.set(appSessionId, created);
    return created;
  }
}

function isPostTerminalGeneration(transcript: TranscriptEvent | undefined): boolean {
  return Boolean(
    transcript && !transcript.isError && POST_TERMINAL_GENERATION_KINDS.has(transcript.kind),
  );
}

function hasSideEffects(sideEffects: NormalizedSideEffects): boolean {
  return Boolean(
    sideEffects.features ??
    sideEffects.progress ??
    sideEffects.missionState ??
    sideEffects.missionChild ??
    sideEffects.childSession,
  );
}

function normalizedSideEffects(normalized: NormalizedEvent): NormalizedSideEffects {
  return {
    ...(normalized.features ? { features: normalized.features } : {}),
    ...(normalized.progress ? { progress: normalized.progress } : {}),
    ...(normalized.missionState ? { missionState: normalized.missionState } : {}),
    ...(normalized.missionChild ? { missionChild: normalized.missionChild } : {}),
    ...(normalized.childSession ? { childSession: normalized.childSession } : {}),
  };
}
