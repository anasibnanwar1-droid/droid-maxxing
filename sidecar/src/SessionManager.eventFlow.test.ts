import assert from 'node:assert/strict';
import test from 'node:test';

import type { ServerEvent } from './protocol.js';
import {
  assistantTextDelta,
  FakeFactorySession,
  successfulResultEvent,
} from './testing/fakeFactoryRuntime.js';
import { createSessionManagerTestContext } from './testing/sessionManagerTestContext.js';

function appendedTexts(events: ServerEvent[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.type === 'event.appended' && event.event.text) texts.push(event.event.text);
  }
  return texts;
}

function designToolPolicies(session: FakeFactorySession): unknown[] {
  return session.settings
    .filter((settings) => settings['disabledToolIds'] !== undefined)
    .map((settings) => settings['disabledToolIds']);
}

function latestSessionUpdate(events: ServerEvent[]) {
  return events
    .filter(
      (event): event is Extract<ServerEvent, { type: 'session.updated' }> =>
        event.type === 'session.updated',
    )
    .at(-1);
}

test('design turns synchronize TodoWrite and unexpected AbortErrors fail the turn', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'event-design',
      title: 'Event design',
      goal: 'initial normal prompt',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();

    const designPrompt =
      'Design Mode reference pack:\n- URL: about:blank\n\nUser instruction:\nMake the hero cleaner';
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: designPrompt,
    });
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'restore normal tools',
    });
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'normal tools stay restored',
    });

    assert.deepEqual(designToolPolicies(provider), [[], ['TodoWrite'], []]);

    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    provider.nextStreamError = abort;
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'unexpected abort',
    });

    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'error' &&
          event.appSessionId === 'provider-1' &&
          event.message === abort.message,
      ),
      true,
    );
    assert.equal(
      context.events.some(
        (event) => event.type === 'session.updated' && event.session.phase === 'failed',
      ),
      true,
    );
  } finally {
    await context.dispose();
  }
});

test('terminal results quarantine only later generation from the same turn', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'event-terminal',
      title: 'Event terminal',
      goal: 'initial',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();
    context.events.length = 0;

    provider.queueStreamEvents([
      assistantTextDelta('final answer'),
      successfulResultEvent('provider-1'),
      assistantTextDelta('leaked tail'),
      {
        type: 'tool_call',
        toolUse: {
          type: 'tool_use',
          id: 'task-1',
          name: 'Task',
          input: { subagent_type: 'worker' },
        },
      },
      {
        type: 'tool_progress',
        toolUseId: 'task-1',
        toolName: 'Task',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-1',
          parameters: { subagent_type: 'worker' },
        },
      },
      {
        type: 'tool_result',
        toolName: 'Execute',
        toolUseId: 'execute-1',
        content: 'boom',
        isError: true,
      },
    ]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'terminal turn',
    });

    assert.deepEqual(appendedTexts(context.events), ['final answer', 'boom']);
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'session.child' &&
          event.event === 'started' &&
          event.providerSessionId === 'worker-1',
      ),
      true,
    );
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'event.appended' &&
          event.event.kind === 'tool_call' &&
          event.event.toolName === 'Task',
      ),
      false,
    );

    provider.queueStreamEvents([assistantTextDelta('next turn answer')]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'next turn',
    });
    assert.equal(appendedTexts(context.events).includes('next turn answer'), true);
  } finally {
    await context.dispose();
  }
});

test('terminal enforcement is scoped to each provider and includes notification events', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'mission-control',
      clientRef: 'event-worker',
      title: 'Event worker',
      goal: 'primary becomes terminal',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await context.provider.waitForPrompts('provider-1', 1);
    await context.waitForIdle();
    context.provider.emitNotification('provider-1', {
      type: 'tool_progress_update',
      toolName: 'Task',
      toolUseId: 'task-1',
      update: {
        type: 'tool_call',
        subagentSessionId: 'worker-1',
        parameters: { subagent_type: 'worker' },
      },
    });
    await context.handle({
      type: 'child.open',
      appSessionId: 'provider-1',
      providerSessionId: 'worker-1',
      role: 'worker',
    });

    context.provider.emitNotification('worker-1', {
      type: 'assistant_text_delta',
      messageId: 'worker-message-1',
      blockIndex: 0,
      textDelta: 'worker notification before terminal',
    });
    assert.equal(
      appendedTexts(context.events).includes('worker notification before terminal'),
      true,
    );

    const worker = context.provider.session('worker-1');
    worker.queueStreamEvents([assistantTextDelta('worker still talking')]);
    await context.handle({
      type: 'child.send',
      appSessionId: 'provider-1',
      providerSessionId: 'worker-1',
      text: 'worker turn',
    });
    assert.equal(appendedTexts(context.events).includes('worker still talking'), true);

    context.provider.emitNotification('worker-1', {
      type: 'assistant_text_delta',
      messageId: 'worker-message-2',
      blockIndex: 0,
      textDelta: 'late worker tail',
    });
    assert.equal(appendedTexts(context.events).includes('late worker tail'), false);
  } finally {
    await context.dispose();
  }
});

test('worker token usage updates totals without replacing the primary context reading', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'mission-control',
      clientRef: 'event-tokens',
      title: 'Event tokens',
      goal: 'initial',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await context.provider.waitForPrompts('provider-1', 1);
    await context.waitForIdle();

    context.provider.session('provider-1').queueStreamEvents([
      {
        type: 'token_usage_update',
        inputTokens: 5,
        outputTokens: 2,
        cacheCreationTokens: 1,
        cacheReadTokens: 2,
        thinkingTokens: 0,
      },
    ]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'primary usage',
    });
    assert.equal(latestSessionUpdate(context.events)?.session.contextTokens, 9);
    assert.equal(latestSessionUpdate(context.events)?.session.contextAccuracy, 'exact');

    await context.handle({
      type: 'child.open',
      appSessionId: 'provider-1',
      providerSessionId: 'worker-tokens',
      role: 'worker',
    });
    context.provider.session('worker-tokens').queueStreamEvents([
      {
        type: 'token_usage_update',
        inputTokens: 50,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
      },
    ]);
    await context.handle({
      type: 'child.send',
      appSessionId: 'provider-1',
      providerSessionId: 'worker-tokens',
      text: 'worker usage',
    });

    const summary = latestSessionUpdate(context.events)?.session;
    assert.equal(summary?.tokensIn, 50);
    assert.equal(summary?.tokensOut, 20);
    assert.equal(summary?.contextTokens, 9);
    assert.equal(summary?.contextAccuracy, 'exact');
  } finally {
    await context.dispose();
  }
});

test('loaded child context follows its runtime session id', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'mission-control',
      clientRef: 'event-child-context',
      title: 'Child context',
      goal: 'initial',
      interactionMode: 'agi',
      autonomy: 'low',
    });
    await context.provider.waitForPrompts('provider-1', 1);
    await context.waitForIdle();

    context.provider.emitNotification('provider-1', {
      type: 'tool_progress_update',
      toolName: 'Task',
      toolUseId: 'task-context',
      update: {
        type: 'tool_call',
        subagentSessionId: 'worker-history-id',
        parameters: { subagent_type: 'worker' },
      },
    });
    context.runtime.loadQueue.set('worker-history-id', [
      new FakeFactorySession('worker-runtime-id', {}, context.calls),
    ]);
    await context.handle({
      type: 'child.open',
      appSessionId: 'provider-1',
      providerSessionId: 'worker-history-id',
      role: 'worker',
    });
    const compactionNotification = (notification: Record<string, unknown>) => ({
      jsonrpc: '2.0',
      method: 'droid.session_notification',
      params: { notification },
    });
    context.provider.emitNotification(
      'worker-runtime-id',
      compactionNotification({
        type: 'droid_working_state_changed',
        newState: 'compacting_conversation',
      }),
    );
    context.provider.emitNotification(
      'worker-runtime-id',
      compactionNotification({
        type: 'session_compacted',
        summaryId: 'summary-context',
        removedCount: 1,
        visibleBoundaryMessageId: null,
      }),
    );
    await context.waitForIdle();
    context.events.length = 0;

    await context.handle({
      type: 'child.send',
      appSessionId: 'provider-1',
      providerSessionId: 'worker-history-id',
      text: 'measure context',
    });

    const runtimeContext = context.events.find(
      (event) =>
        event.type === 'context.updated' &&
        event.appSessionId === 'provider-1' &&
        event.sourceSessionId === 'worker-runtime-id',
    );
    assert.equal(runtimeContext?.type, 'context.updated');
    assert.equal(runtimeContext.stats.compactions, 1);
  } finally {
    await context.dispose();
  }
});
