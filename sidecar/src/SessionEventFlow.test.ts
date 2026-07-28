import assert from 'node:assert/strict';
import test from 'node:test';

import { MissionState, type DroidStreamEvent } from '@factory/droid-sdk';

import { SessionEventFlow, type NormalizedSideEffects } from './SessionEventFlow.js';
import type { TranscriptEvent } from './protocol.js';
import { assistantTextDelta, successfulResultEvent } from './testing/fakeFactoryRuntime.js';

function createHarness() {
  const transcripts: TranscriptEvent[] = [];
  const sideEffects: Array<{
    appSessionId: string;
    sourceProviderSessionId: string;
    value: NormalizedSideEffects;
  }> = [];
  const trace: string[] = [];
  const eventFlow = new SessionEventFlow({
    appendTranscript: (event) => {
      trace.push(`append:${event.kind}`);
      transcripts.push(event);
    },
    applySideEffects: (appSessionId, sourceProviderSessionId, value) => {
      trace.push(`side:${sideEffectKind(value)}`);
      sideEffects.push({ appSessionId, sourceProviderSessionId, value });
    },
  });
  return { eventFlow, sideEffects, trace, transcripts };
}

function sideEffectKind(sideEffects: NormalizedSideEffects): string {
  if (sideEffects.childSession) return 'child';
  if (sideEffects.tokens) return 'tokens';
  if (sideEffects.features) return 'features';
  if (sideEffects.progress) return 'progress';
  if (sideEffects.missionState) return 'missionState';
  if (sideEffects.missionChild) return 'missionChild';
  return 'unknown';
}

function taskToolCall(toolUseId: string): DroidStreamEvent {
  return {
    type: 'tool_call',
    toolUse: {
      type: 'tool_use',
      id: toolUseId,
      name: 'Task',
      input: { subagent_type: 'worker', prompt: 'Inspect the event flow' },
    },
  };
}

function failedTaskResult(toolUseId: string): DroidStreamEvent {
  return {
    type: 'tool_result',
    toolName: 'Task',
    toolUseId,
    content: 'worker failed',
    isError: true,
  };
}

function assistantNotification(text: string): Record<string, unknown> {
  return {
    type: 'assistant_text_delta',
    messageId: `message-${text}`,
    blockIndex: 0,
    textDelta: text,
  };
}

function childNotification(providerSessionId: string): Record<string, unknown> {
  return {
    type: 'tool_progress_update',
    toolName: 'Task',
    toolUseId: 'task-notification',
    update: {
      type: 'tool_call',
      subagentSessionId: providerSessionId,
      parameters: { subagent_type: 'worker' },
    },
  };
}

test('stream ingress appends an accepted transcript before one side-effect callback', () => {
  const harness = createHarness();

  harness.eventFlow.applyStreamEvent('app-1', 'provider-1', 'primary', taskToolCall('task-1'));

  assert.deepEqual(harness.trace, ['append:tool_call', 'side:child']);
  assert.equal(harness.transcripts[0]?.sourceSessionId, 'provider-1');
  assert.equal(harness.sideEffects.length, 1);
  assert.equal(harness.sideEffects[0]?.appSessionId, 'app-1');
  assert.equal(harness.sideEffects[0]?.sourceProviderSessionId, 'provider-1');
});

test('notification ingress converges on the same transcript gating and side-effect path', () => {
  const harness = createHarness();

  harness.eventFlow.applyNotification(
    'app-1',
    'worker-1',
    'worker',
    assistantNotification('before terminal'),
  );
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'worker-1',
    'worker',
    successfulResultEvent('worker-1'),
  );
  harness.eventFlow.applyNotification(
    'app-1',
    'worker-1',
    'worker',
    assistantNotification('late tail'),
  );
  harness.eventFlow.applyNotification('app-1', 'worker-1', 'worker', childNotification('worker-2'));

  assert.deepEqual(
    harness.transcripts.map((event) => event.text),
    ['before terminal'],
  );
  assert.equal(harness.sideEffects.length, 1);
  assert.equal(harness.sideEffects[0]?.value.childSession?.providerSessionId, 'worker-2');
});

test('a terminal result drops later generated transcript from only that source', () => {
  const harness = createHarness();

  harness.eventFlow.applyStreamEvent(
    'app-1',
    'primary-1',
    'primary',
    successfulResultEvent('primary-1'),
  );
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'primary-1',
    'primary',
    assistantTextDelta('must be dropped'),
  );
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'worker-1',
    'worker',
    assistantTextDelta('worker survives'),
  );

  assert.deepEqual(
    harness.transcripts.map((event) => event.text),
    ['worker survives'],
  );
});

test('post-terminal errors plus child, Mission, and token side effects still flow', () => {
  const harness = createHarness();
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'worker-1',
    'worker',
    successfulResultEvent('worker-1'),
  );

  harness.eventFlow.applyStreamEvent('app-1', 'worker-1', 'worker', failedTaskResult('task-1'));
  harness.eventFlow.applyStreamEvent('app-1', 'worker-1', 'worker', {
    type: 'mission_state_changed',
    state: MissionState.Running,
  });
  harness.eventFlow.applyStreamEvent('app-1', 'worker-1', 'worker', {
    type: 'token_usage_update',
    inputTokens: 5,
    outputTokens: 2,
    cacheCreationTokens: 1,
    cacheReadTokens: 3,
    thinkingTokens: 0,
  });

  assert.deepEqual(harness.trace, [
    'append:tool_result',
    'side:child',
    'side:missionState',
    'side:tokens',
  ]);
  assert.equal(harness.transcripts[0]?.isError, true);
  assert.equal(harness.transcripts[0]?.text, 'worker failed');
  assert.equal(harness.sideEffects[0]?.value.childSession?.done, true);
  assert.equal(harness.sideEffects[1]?.value.missionState, MissionState.Running);
  assert.deepEqual(harness.sideEffects[2]?.value.tokens, {
    tokensIn: 9,
    tokensOut: 2,
    contextTokens: 10,
  });
});

test('terminal gates are isolated across sources and app sessions', () => {
  const harness = createHarness();
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'primary-1',
    'primary',
    successfulResultEvent('primary-1'),
  );
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'worker-1',
    'worker',
    successfulResultEvent('worker-1'),
  );

  harness.eventFlow.applyStreamEvent(
    'app-1',
    'primary-1',
    'primary',
    assistantTextDelta('primary blocked'),
  );
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'worker-1',
    'worker',
    assistantTextDelta('worker one blocked'),
  );
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'worker-2',
    'worker',
    assistantTextDelta('worker two accepted'),
  );
  harness.eventFlow.applyStreamEvent(
    'app-2',
    'primary-1',
    'primary',
    assistantTextDelta('other app accepted'),
  );

  assert.deepEqual(
    harness.transcripts.map((event) => event.text),
    ['worker two accepted', 'other app accepted'],
  );
});

test('beginTurn reopens only the requested source', () => {
  const harness = createHarness();
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'worker-1',
    'worker',
    successfulResultEvent('worker-1'),
  );
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'worker-2',
    'worker',
    successfulResultEvent('worker-2'),
  );

  harness.eventFlow.beginTurn('app-1', 'worker-1');
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'worker-1',
    'worker',
    assistantTextDelta('worker one next turn'),
  );
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'worker-2',
    'worker',
    assistantTextDelta('worker two still blocked'),
  );

  assert.deepEqual(
    harness.transcripts.map((event) => event.text),
    ['worker one next turn'],
  );
});

test('forgetSession clears only the unregistered app terminal state', () => {
  const harness = createHarness();
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'provider',
    'primary',
    successfulResultEvent('provider'),
  );
  harness.eventFlow.applyStreamEvent(
    'app-2',
    'provider',
    'primary',
    successfulResultEvent('provider'),
  );

  harness.eventFlow.forgetSession('app-1');
  harness.eventFlow.applyStreamEvent(
    'app-1',
    'provider',
    'primary',
    assistantTextDelta('forgotten app accepted'),
  );
  harness.eventFlow.applyStreamEvent(
    'app-2',
    'provider',
    'primary',
    assistantTextDelta('other app remains blocked'),
  );

  assert.deepEqual(
    harness.transcripts.map((event) => event.text),
    ['forgotten app accepted'],
  );
});
