import assert from 'node:assert/strict';

import type { ServerEvent, SessionRole, SessionSummary } from '../protocol.js';
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
  h.runtime.loadQueue.set(input.childSessionId, [child]);
  await h.handle({
    type: 'child.open',
    appSessionId: parentAppSessionId,
    providerSessionId: input.childSessionId,
    role: input.role,
  });
  assert.equal(
    h.events.some(
      (event) =>
        event.type === 'child.updated' &&
        'parentAppSessionId' in event &&
        event.parentAppSessionId === parentAppSessionId &&
        event.childSessionId === input.childSessionId &&
        event.role === input.role,
    ),
    true,
  );
  return child;
}

export function exactSettingsEvents(
  events: ServerEvent[],
  childSessionId: string,
): Extract<ServerEvent, { type: 'session.child'; childSessionId: string }>[] {
  return events.filter(
    (event): event is Extract<ServerEvent, { type: 'session.child'; childSessionId: string }> =>
      event.type === 'session.child' &&
      'childSessionId' in event &&
      event.childSessionId === childSessionId,
  );
}
