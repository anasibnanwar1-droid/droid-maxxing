import { ReasoningEffort } from '@factory/droid-sdk';

import type { FactorySession } from '../DroidRuntime.js';
import type { LiveSession } from '../SessionLifecycle.js';

export function createCompactionTestLiveSession(
  appSessionId: string,
  session: FactorySession,
): LiveSession {
  return {
    summary: {
      appSessionId,
      providerSessionId: session.sessionId,
      sessionPurpose: 'chat',
      interactionMode: 'auto',
      role: 'user',
      title: appSessionId,
      goal: 'test',
      cwd: '/workspace',
      workspaceKind: 'folder',
      modelId: 'model-default',
      reasoningEffort: ReasoningEffort.Low,
      autonomy: 'low',
      phase: 'paused',
      features: [],
      tokensIn: 0,
      tokensOut: 0,
      contextTokens: 0,
      maxContextTokens: 1_000,
      createdAt: 1,
      updatedAt: 1,
    },
    session,
    streaming: false,
    autoCompacting: false,
    pendingSends: [],
    childSessions: new Map(),
    childRuntimeGenerations: new Map(),
    knownChildSessions: new Set(),
    completedChildSessions: new Set(),
    linkedChildSessions: new Set(),
    childSessionToolUseIds: new Map(),
    retiredChildProviderSessionIds: new Map(),
    childSessionSettings: new Map(),
    pendingChildSessions: [],
    mcpServers: [],
    mcpConfigs: [],
  };
}
