import assert from 'node:assert/strict';

import type { ChildSessionSummary, ServerEvent, SessionRole, SessionSummary } from '../protocol.js';
import { FakeFactorySession } from './fakeFactoryRuntime.js';
import type { SessionManagerTestContext } from './sessionManagerTestContext.js';

export function latestSessionList(events: ServerEvent[]): SessionSummary[] {
  return events.filter((event) => event.type === 'sessions.list').at(-1)?.sessions ?? [];
}

export async function createMission(
  h: SessionManagerTestContext,
  options: {
    workerModel?: string;
    validatorModel?: string;
  } = {},
): Promise<void> {
  await h.create({
    sessionPurpose: 'mission-control',
    clientRef: 'child-settings',
    title: 'Child settings',
    goal: 'go',
    interactionMode: 'agi',
    autonomy: 'low',
    ...options,
  });
  await h.waitForIdle();
}

export async function openChild(
  h: SessionManagerTestContext,
  childSessionId: string,
  providerSessionId: string,
  role: Exclude<SessionRole, 'primary'>,
  modelId: string,
): Promise<FakeFactorySession> {
  return openChildForParent(h, 'provider-1', {
    childSessionId,
    providerSessionId,
    role,
    modelId,
  });
}

export async function openChildForParent(
  h: SessionManagerTestContext,
  parentAppSessionId: string,
  input: {
    childSessionId: string;
    providerSessionId: string;
    role: Exclude<SessionRole, 'primary'>;
    modelId: string;
  },
): Promise<FakeFactorySession> {
  const child = new FakeFactorySession(input.providerSessionId, {}, h.calls);
  child.setInitModel(input.modelId);
  h.history.seedChildSessions([
    {
      parentAppSessionId,
      childSessionId: input.childSessionId,
      providerSessionId: input.providerSessionId,
      role: input.role,
      status: 'paused',
      modelId: input.modelId,
      spawnLink: { kind: 'spawn', id: `spawn-${input.childSessionId}` },
      transcriptAvailable: true,
      updatedAt: Date.now(),
    },
  ]);
  h.runtime.loadQueue.set(input.providerSessionId, [child]);
  await h.handle({
    type: 'child.open',
    parentAppSessionId,
    childSessionId: input.childSessionId,
    requestId: `open-${input.childSessionId}`,
  });
  assert.equal(
    h.events.some(
      (event) =>
        event.type === 'child.updated' &&
        event.parentAppSessionId === parentAppSessionId &&
        event.childSessionId === input.childSessionId &&
        event.access === 'ready',
    ),
    true,
  );
  return child;
}

export function exactSettingsEvents(
  events: ServerEvent[],
  childSessionId: string,
): ChildSessionSummary[] {
  return events.flatMap((event) =>
    event.type === 'session.child' && event.child.childSessionId === childSessionId
      ? [event.child]
      : [],
  );
}
