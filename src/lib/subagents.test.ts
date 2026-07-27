import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEvent, ChildSessionHistoryLink } from '../types/bridge';
import type { WorkerInfo } from '../hooks/useStore';
import { resolveWorkers, richerSubagent, subagentLatest } from './subagents';
import { subagentInfo } from './tools';

function ev(
  p: Partial<TranscriptEvent> &
    Pick<TranscriptEvent, 'id' | 'sourceSessionId' | 'role' | 'ts' | 'kind'>,
): TranscriptEvent {
  return { appSessionId: 'm1', ...p } as TranscriptEvent;
}

function workersFromLinks(links: ChildSessionHistoryLink[]): WorkerInfo[] {
  return links.map((link) => ({
    providerSessionId: link.providerSessionId,
    status: link.status ?? 'completed',
    startedAt: 0,
    label: link.label,
    toolUseId: link.toolUseId,
  }));
}

test('resolveWorkers preserves canonical child-session links', () => {
  const links = [
    { providerSessionId: 'provider-b', toolUseId: 'tool-a', label: 'worker' },
    { providerSessionId: 'provider-a', toolUseId: 'tool-b', label: 'validator' },
  ];
  const workers = workersFromLinks(links);
  const resolved = resolveWorkers(workers, []);

  assert.equal(resolved, workers);
  assert.equal(resolved[0].providerSessionId, 'provider-b');
  assert.equal(resolved[0].toolUseId, 'tool-a');
  assert.equal(resolved[1].providerSessionId, 'provider-a');
  assert.equal(resolved[1].toolUseId, 'tool-b');
});

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

test('richerSubagent merges a label-only delta with a later description-only delta', () => {
  const merged = richerSubagent(
    spawn({ subagent_type: 'worker' }),
    spawn({ description: 'fix the bug' }),
  );
  assert.deepEqual(subagentInfo(merged.toolArgs), { label: 'worker', description: 'fix the bug' });
});

test('richerSubagent merges a description-only delta with a later label-only delta', () => {
  const merged = richerSubagent(
    spawn({ description: 'fix the bug' }),
    spawn({ subagent_type: 'worker' }),
  );
  assert.deepEqual(subagentInfo(merged.toolArgs), { label: 'worker', description: 'fix the bug' });
});

test('richerSubagent returns the latest event untouched when it already carries both fields', () => {
  const next = spawn({ subagent_type: 'worker', description: 'do X' });
  assert.equal(richerSubagent(spawn({ subagent_type: 'worker' }), next), next);
});

test('subagentLatest surfaces a failed tool result as a failure, not stale activity', () => {
  const out = subagentLatest({
    kind: 'tool_result',
    text: 'command exited 1',
    toolName: 'Bash',
    isError: true,
  });
  assert.equal(out?.head, 'Failed');
  assert.equal(out?.body, 'command exited 1');
});

test('subagentLatest maps an error event to Error and a missing latest to null', () => {
  assert.equal(subagentLatest({ kind: 'error', text: 'boom' })?.head, 'Error');
  assert.equal(subagentLatest(undefined), null);
});
