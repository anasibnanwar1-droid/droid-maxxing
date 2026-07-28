import assert from 'node:assert/strict';
import test from 'node:test';

import { ReasoningEffort } from '@factory/droid-sdk';

import { FakeFactoryRuntime, FakeFactorySession, type RecordedCall } from './fakeFactoryRuntime.js';

test('created sessions expose their requested settings', async () => {
  const calls: RecordedCall[] = [];
  const runtime = new FakeFactoryRuntime(calls);

  const session = await runtime.createSession({
    cwd: '/workspace',
    interactionMode: 'spec',
    modelId: 'model-requested',
    reasoningEffort: 'high',
  });

  assert.deepEqual(session.initResult.settings, {
    modelId: 'model-requested',
    reasoningEffort: ReasoningEffort.High,
    interactionMode: 'spec',
  });
});

test('notification subscriptions honor SDK type filters', () => {
  const calls: RecordedCall[] = [];
  const session = new FakeFactorySession('provider-filtered', {}, calls);
  const allNotifications: Record<string, unknown>[] = [];
  const workingNotifications: Record<string, unknown>[] = [];
  session.onNotification((notification) => allNotifications.push(notification));
  session.onNotification((notification) => workingNotifications.push(notification), {
    type: 'droid_working_state_changed',
  });
  const assistantText = {
    jsonrpc: '2.0',
    method: 'droid.session_notification',
    params: {
      notification: {
        type: 'assistant_text_complete',
        messageId: 'message-filtered',
        blockIndex: 0,
      },
    },
  };
  const working = {
    jsonrpc: '2.0',
    method: 'droid.session_notification',
    params: {
      notification: {
        type: 'droid_working_state_changed',
        newState: 'idle',
      },
    },
  };

  session.emitNotification(assistantText);
  session.emitNotification(working);

  assert.deepEqual(allNotifications, [assistantText, working]);
  assert.deepEqual(workingNotifications, [working]);
});
