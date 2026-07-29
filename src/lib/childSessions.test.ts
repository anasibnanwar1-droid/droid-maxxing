import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEvent } from '../types/bridge';
import {
  mergeChildSessionSpawn,
  childSessionLatest,
  selectedChildForParent,
  shouldOpenSelectedChild,
  visibleSessionIsLive,
} from './childSessions';
import { childSessionInfo } from './tools';

function ev(
  p: Partial<TranscriptEvent> &
    Pick<TranscriptEvent, 'id' | 'sourceSessionId' | 'role' | 'ts' | 'kind'>,
): TranscriptEvent {
  return { appSessionId: 'app-1', ...p } as TranscriptEvent;
}

const spawn = (toolArgs: Record<string, unknown>): TranscriptEvent =>
  ev({
    id: 's',
    sourceSessionId: 'orc',
    role: 'primary',
    ts: 1,
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs,
  });

test('mergeChildSessionSpawn merges a label-only delta with a later description-only delta', () => {
  const merged = mergeChildSessionSpawn(
    spawn({ subagent_type: 'worker' }),
    spawn({ description: 'fix the bug' }),
  );
  assert.deepEqual(childSessionInfo(merged.toolArgs), {
    label: 'worker',
    description: 'fix the bug',
  });
});

test('mergeChildSessionSpawn merges a description-only delta with a later label-only delta', () => {
  const merged = mergeChildSessionSpawn(
    spawn({ description: 'fix the bug' }),
    spawn({ subagent_type: 'worker' }),
  );
  assert.deepEqual(childSessionInfo(merged.toolArgs), {
    label: 'worker',
    description: 'fix the bug',
  });
});

test('mergeChildSessionSpawn returns the latest event untouched when it already carries both fields', () => {
  const next = spawn({ subagent_type: 'worker', description: 'do X' });
  assert.equal(mergeChildSessionSpawn(spawn({ subagent_type: 'worker' }), next), next);
});

test('childSessionLatest surfaces a failed tool result as a failure, not stale activity', () => {
  const out = childSessionLatest({
    kind: 'tool_result',
    text: 'command exited 1',
    toolName: 'Bash',
    isError: true,
  });
  assert.equal(out?.head, 'Failed');
  assert.equal(out?.body, 'command exited 1');
});

test('childSessionLatest maps an error event to Error and a missing latest to null', () => {
  assert.equal(childSessionLatest({ kind: 'error', text: 'boom' })?.head, 'Error');
  assert.equal(childSessionLatest(undefined), null);
});

test('selected child targeting is parent-scoped and independent of session mode', () => {
  const child = {
    parentAppSessionId: 'mission-parent',
    childSessionId: 'worker-logical',
    role: 'validator' as const,
    status: 'paused' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
  };
  const children = { 'mission-parent': { 'worker-logical': child } };

  assert.equal(
    selectedChildForParent(
      'mission-parent',
      { parentAppSessionId: 'mission-parent', childSessionId: 'worker-logical' },
      children,
    ),
    child,
  );
  assert.equal(
    selectedChildForParent(
      'other-parent',
      { parentAppSessionId: 'mission-parent', childSessionId: 'worker-logical' },
      children,
    ),
    undefined,
  );
});

test('visible liveness follows the selected child instead of the parent', () => {
  const child = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    role: 'worker' as const,
    status: 'running' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
  };

  assert.equal(visibleSessionIsLive(false, child), true);
  assert.equal(visibleSessionIsLive(true, { ...child, status: 'paused' }), false);
  assert.equal(visibleSessionIsLive(true, undefined), true);
});

test('child open retries require explicit reselection after terminal access', () => {
  assert.equal(shouldOpenSelectedChild(undefined), true);
  assert.equal(shouldOpenSelectedChild({ state: 'opening', requestId: 'request-a' }), false);
  assert.equal(
    shouldOpenSelectedChild({
      state: 'ready',
      requestId: 'request-a',
      runtimeGeneration: 2,
    }),
    false,
  );
  assert.equal(shouldOpenSelectedChild({ state: 'history', requestId: 'request-a' }), false);
  assert.equal(shouldOpenSelectedChild({ state: 'failed', requestId: 'request-a' }), false);
  assert.equal(shouldOpenSelectedChild({ state: 'closed', requestId: null }), false);
});
