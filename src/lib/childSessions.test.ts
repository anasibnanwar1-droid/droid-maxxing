import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEvent } from '../types/bridge';
import { mergeChildSessionSpawn, childSessionLatest } from './childSessions';
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
