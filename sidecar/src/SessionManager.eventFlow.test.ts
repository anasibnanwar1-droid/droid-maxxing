import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ServerEvent } from './protocol.js';
import { writeDnaFile } from './design/dnaFiles.js';
import { serializeTokenBlock } from './design/tokens.js';
import { writeValidatorConfig } from './design/validator/config.js';
import {
  assistantTextDelta,
  FakeFactorySession,
  successfulResultEvent,
  type RecordedCall,
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

test('plain Studio prompts disable TodoWrite from the canonical session purpose', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'design',
      clientRef: 'studio-plain',
      title: 'Studio plain',
      goal: 'Make the landing page calmer',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();

    assert.deepEqual(designToolPolicies(provider), [['TodoWrite']]);
  } finally {
    await context.dispose();
  }
});

test('attached-reference Studio prompts keep TodoWrite disabled', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'design',
      clientRef: 'studio-reference',
      title: 'Studio reference',
      goal: 'Use this visual direction\n\nDROIDEX DESIGN reference pack:\n{"kind":"canvas-image","id":"reference-1"}',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();

    assert.deepEqual(designToolPolicies(provider), [['TodoWrite']]);
  } finally {
    await context.dispose();
  }
});

test('a completed Studio turn starts configured validation without delaying settlement', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-post-prompt-validator-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeDnaFile(
    cwd,
    'design',
    serializeTokenBlock({
      colors: { background: '#ffffff', text: '#111111' },
      fonts: { sans: 'Inter, sans-serif' },
      typeScale: [12, 14, 16],
      spacing: [4, 8, 12],
      radii: [4, 8],
    }),
  );
  writeValidatorConfig(cwd, {
    pages: [{ id: 'home', url: 'http://127.0.0.1:4173' }],
    viewports: ['desktop'],
    runAfterDesignPrompt: true,
  });
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'design',
      clientRef: 'studio-validator',
      cwd,
      title: 'Studio validator',
      goal: 'Polish the home page',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    await context.waitForIdle();

    assert.equal(
      context.calls.some((call) => call.target === 'browser' && call.method === 'open'),
      true,
    );
    assert.equal(
      context.events.some((event) => event.type === 'design.validator.report'),
      true,
    );
  } finally {
    await context.dispose();
  }
});

test('ordinary chat prompts keep TodoWrite enabled', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'ordinary-chat-tools',
      title: 'Ordinary chat',
      goal: 'Explain this repository',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();

    assert.deepEqual(designToolPolicies(provider), [[]]);
  } finally {
    await context.dispose();
  }
});

function latestSessionUpdate(events: ServerEvent[]) {
  return events
    .filter(
      (event): event is Extract<ServerEvent, { type: 'session.updated' }> =>
        event.type === 'session.updated',
    )
    .at(-1);
}

function isRecordedTranscript(call: RecordedCall, text: string): boolean {
  const event = call.args[0];
  return (
    call.target === 'history' &&
    call.method === 'recordEvent' &&
    typeof event === 'object' &&
    event !== null &&
    'text' in event &&
    event.text === text
  );
}

function isAppendedTranscript(call: RecordedCall, text: string): boolean {
  const event = call.args[0];
  if (
    call.target !== 'protocol' ||
    call.method !== 'event' ||
    typeof event !== 'object' ||
    event === null ||
    !('type' in event) ||
    event.type !== 'event.appended' ||
    !('event' in event) ||
    typeof event.event !== 'object' ||
    event.event === null
  )
    return false;
  return 'text' in event.event && event.event.text === text;
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

    const recordIndex = context.calls.findIndex((call) =>
      isRecordedTranscript(call, 'final answer'),
    );
    const emitIndex = context.calls.findIndex((call) => isAppendedTranscript(call, 'final answer'));
    assert.ok(recordIndex >= 0);
    assert.ok(emitIndex > recordIndex);
    assert.deepEqual(appendedTexts(context.events), ['final answer', 'boom']);
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'session.child' &&
          event.child.status === 'running' &&
          event.child.childSessionId === 'child-1',
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
    const primary = context.provider.session('provider-1');
    primary.queueStreamEvents([
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'task-1',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-logical',
          parameters: { subagent_type: 'worker' },
        },
      },
    ]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'spawn worker',
    });
    const worker = new FakeFactorySession('worker-backend', {}, context.calls);
    context.runtime.loadQueue.set('worker-logical', [worker]);
    await context.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      requestId: 'open-child-1',
    });

    context.provider.emitNotification('worker-backend', {
      type: 'assistant_text_delta',
      messageId: 'worker-message-1',
      blockIndex: 0,
      textDelta: 'worker notification before terminal',
    });
    assert.equal(
      appendedTexts(context.events).includes('worker notification before terminal'),
      true,
    );
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'event.appended' &&
          event.event.text === 'worker notification before terminal' &&
          event.event.appSessionId === 'provider-1' &&
          event.event.sourceSessionId === 'child-1',
      ),
      true,
    );

    worker.queueStreamEvents([assistantTextDelta('worker still talking')]);
    await context.handle({
      type: 'child.send',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      text: 'worker turn',
    });
    assert.equal(appendedTexts(context.events).includes('worker still talking'), true);
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'event.appended' &&
          event.event.text === 'worker still talking' &&
          event.event.sourceSessionId === 'child-1',
      ),
      true,
    );

    context.provider.emitNotification('worker-backend', {
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

test('current SDK Task result persists and opens the exact completed child', async () => {
  const context = createSessionManagerTestContext();
  try {
    await context.create({
      sessionPurpose: 'chat',
      clientRef: 'event-task-result-child',
      title: 'Task result child',
      goal: 'initial',
      interactionMode: 'auto',
      autonomy: 'low',
    });
    const provider = context.provider.session('provider-1');
    await provider.waitForPrompts(1);
    await context.waitForIdle();
    context.events.length = 0;

    provider.queueStreamEvents([
      {
        type: 'tool_call',
        toolUse: {
          type: 'tool_use',
          id: 'task-current',
          name: 'Task',
          input: {
            subagent_type: 'worker',
            description: 'Smoke test reply',
            prompt: 'Reply exactly CHILD_SMOKE_OK and stop.',
          },
        },
      },
      {
        type: 'tool_result',
        toolName: 'Task',
        toolUseId: 'task-current',
        content: 'session_id: provider-child-current\nCHILD_SMOKE_OK',
        isError: false,
      },
    ]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'spawn worker',
    });

    const child = context.history.childSessions('provider-1')[0];
    assert.equal(child?.parentAppSessionId, 'provider-1');
    assert.equal(child?.childSessionId, 'child-1');
    assert.equal(child?.providerSessionId, 'provider-child-current');
    assert.equal(child?.status, 'completed');
    assert.equal(child?.transcriptAvailable, true);
    assert.deepEqual(child?.spawnLink, { kind: 'tool-use', id: 'task-current' });

    await context.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      requestId: 'open-current-child',
    });
    assert.equal(
      context.events.some(
        (event) =>
          event.type === 'child.updated' &&
          event.access === 'history' &&
          event.parentAppSessionId === 'provider-1' &&
          event.childSessionId === 'child-1' &&
          event.requestId === 'open-current-child',
      ),
      true,
    );
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

    context.history.seedChildSessions([
      {
        parentAppSessionId: 'provider-1',
        childSessionId: 'child-tokens',
        providerSessionId: 'worker-tokens',
        role: 'worker',
        status: 'paused',
        modelId: 'model-default',
        transcriptAvailable: true,
        updatedAt: Date.now(),
      },
    ]);
    await context.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-tokens',
      requestId: 'open-child-tokens',
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
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-tokens',
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

test('loaded child context follows its parent-scoped logical identity', async () => {
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

    const primary = context.provider.session('provider-1');
    primary.queueStreamEvents([
      {
        type: 'tool_progress',
        toolName: 'Task',
        toolUseId: 'task-context',
        content: '',
        update: {
          type: 'tool_call',
          subagentSessionId: 'worker-history-id',
          parameters: { subagent_type: 'worker' },
        },
      },
    ]);
    await context.handle({
      type: 'session.send',
      appSessionId: 'provider-1',
      text: 'spawn worker',
    });
    context.runtime.loadQueue.set('worker-history-id', [
      new FakeFactorySession('worker-runtime-id', {}, context.calls),
    ]);
    await context.handle({
      type: 'child.open',
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      requestId: 'open-child-history',
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
      parentAppSessionId: 'provider-1',
      childSessionId: 'child-1',
      text: 'measure context',
    });

    const runtimeContext = context.events.find(
      (event) =>
        event.type === 'context.updated' &&
        event.appSessionId === 'provider-1' &&
        event.sourceSessionId === 'child-1' &&
        event.parentAppSessionId === 'provider-1' &&
        event.childSessionId === 'child-1',
    );
    assert.equal(runtimeContext?.type, 'context.updated');
    assert.equal(runtimeContext.stats.compactions, 1);
  } finally {
    await context.dispose();
  }
});
