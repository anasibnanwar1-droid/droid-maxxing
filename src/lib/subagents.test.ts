import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEvent, WorkerHistoryLink } from '../types/bridge';
import type { WorkerInfo } from '../hooks/useStore';
import { reconstructWorkersFromTranscript, resolveWorkers, richerSubagent, subagentLatest } from './subagents';
import { subagentInfo } from './tools';

function ev(p: Partial<TranscriptEvent> & Pick<TranscriptEvent, 'id' | 'agentSessionId' | 'role' | 'ts' | 'kind'>): TranscriptEvent {
  return { missionId: 'm1', ...p } as TranscriptEvent;
}

// resolveWorkers consumes already-hydrated worker entries (the backend/store
// builds these from persisted links); build them here to drive its tests.
function workersFromLinks(links: WorkerHistoryLink[]): WorkerInfo[] {
  return links.map((link) => ({
    sessionId: link.workerSessionId,
    status: link.status ?? 'completed',
    startedAt: 0,
    label: link.label,
    toolUseId: link.toolUseId,
  }));
}

// Two spawns with the SAME label, where the worker sessions appear in an order
// opposite to the spawn order, so order-based reconstruction mis-pairs them.
const transcript: TranscriptEvent[] = [
  ev({ id: 's1', agentSessionId: 'orc', role: 'orchestrator', ts: 1, kind: 'tool_call', toolName: 'Task', toolArgs: { subagent_type: 'worker' }, toolUseId: 'tool-A' }),
  ev({ id: 's2', agentSessionId: 'orc', role: 'orchestrator', ts: 2, kind: 'tool_call', toolName: 'Task', toolArgs: { subagent_type: 'worker' }, toolUseId: 'tool-B' }),
  ev({ id: 'w1', agentSessionId: 'sess-A', role: 'worker', ts: 3, kind: 'text', text: 'hi from A' }),
  ev({ id: 'w2', agentSessionId: 'sess-B', role: 'worker', ts: 4, kind: 'text', text: 'hi from B' }),
];

// The persisted exact mapping is the inverse of first-seen order.
const links = [
  { workerSessionId: 'sess-B', toolUseId: 'tool-A', label: 'worker' },
  { workerSessionId: 'sess-A', toolUseId: 'tool-B', label: 'worker' },
];

test('transcript reconstruction would mis-pair out-of-order sessions (fallback only)', () => {
  const rebuilt = reconstructWorkersFromTranscript(transcript);
  // Order-based pairing links the first spawn to the first-seen session.
  assert.equal(rebuilt.find((w) => w.toolUseId === 'tool-A')?.sessionId, 'sess-A');
  assert.equal(rebuilt.find((w) => w.toolUseId === 'tool-B')?.sessionId, 'sess-B');
});

test('resolveWorkers prefers the exact mapping over transcript reconstruction', () => {
  const resolved = resolveWorkers(workersFromLinks(links), transcript);
  assert.equal(resolved.find((w) => w.toolUseId === 'tool-A')?.sessionId, 'sess-B');
  assert.equal(resolved.find((w) => w.toolUseId === 'tool-B')?.sessionId, 'sess-A');
});

test('resolveWorkers falls back to reconstruction when no exact mapping exists', () => {
  const resolved = resolveWorkers([], transcript);
  assert.equal(resolved.length, 2);
  assert.equal(resolved.find((w) => w.toolUseId === 'tool-A')?.sessionId, 'sess-A');
});

test('resolveWorkers merges reconstructed workers when persisted links are partial', () => {
  // A long-lived session: only the newer spawn (tool-B) has a persisted link;
  // the older spawn (tool-A -> sess-A) predates link persistence.
  const partialLinks = [{ workerSessionId: 'sess-B', toolUseId: 'tool-B', label: 'worker' }];
  const resolved = resolveWorkers(workersFromLinks(partialLinks), transcript);
  // The linked worker is kept exactly, and the older unlinked spawn is still
  // resolvable from the transcript instead of being dropped.
  assert.equal(resolved.find((w) => w.sessionId === 'sess-B')?.toolUseId, 'tool-B');
  assert.ok(resolved.some((w) => w.sessionId === 'sess-A'));
  assert.equal(resolved.length, 2);
});

test('resolveWorkers does not let an unlinked worker steal a linked spawn (out of order)', () => {
  // sess-B (linked to tool-B) emits before sess-A even though tool-A was spawned
  // first. Index pairing over the whole transcript would hand sess-A tool-B
  // (the linked spawn); excluding the linked session AND its spawn before
  // pairing keeps sess-A on its own tool-A.
  const tx: TranscriptEvent[] = [
    ev({ id: 's1', agentSessionId: 'orc', role: 'orchestrator', ts: 1, kind: 'tool_call', toolName: 'Task', toolArgs: { subagent_type: 'worker' }, toolUseId: 'tool-A' }),
    ev({ id: 's2', agentSessionId: 'orc', role: 'orchestrator', ts: 2, kind: 'tool_call', toolName: 'Task', toolArgs: { subagent_type: 'worker' }, toolUseId: 'tool-B' }),
    ev({ id: 'wB', agentSessionId: 'sess-B', role: 'worker', ts: 3, kind: 'text', text: 'B' }),
    ev({ id: 'wA', agentSessionId: 'sess-A', role: 'worker', ts: 4, kind: 'text', text: 'A' }),
  ];
  const linked = [{ workerSessionId: 'sess-B', toolUseId: 'tool-B', label: 'worker' }];
  const resolved = resolveWorkers(workersFromLinks(linked), tx);
  assert.equal(resolved.find((w) => w.sessionId === 'sess-B')?.toolUseId, 'tool-B');
  assert.equal(resolved.find((w) => w.sessionId === 'sess-A')?.toolUseId, 'tool-A');
});

test('reconstruct pairs causally so an unrelated session between spawns steals no spawn', () => {
  // sess-X has no spawn (e.g. a nested/validator session) and appears between
  // the two spawns. Causal pairing must leave it unpaired and still give the
  // later worker its later spawn instead of shifting everything by one.
  const tx: TranscriptEvent[] = [
    ev({ id: 's1', agentSessionId: 'orc', role: 'orchestrator', ts: 1, kind: 'tool_call', toolName: 'Task', toolArgs: { subagent_type: 'worker' }, toolUseId: 'tool-A' }),
    ev({ id: 'wA', agentSessionId: 'sess-A', role: 'worker', ts: 2, kind: 'text', text: 'A' }),
    ev({ id: 'wX', agentSessionId: 'sess-X', role: 'worker', ts: 3, kind: 'text', text: 'X' }),
    ev({ id: 's2', agentSessionId: 'orc', role: 'orchestrator', ts: 4, kind: 'tool_call', toolName: 'Task', toolArgs: { subagent_type: 'worker' }, toolUseId: 'tool-B' }),
    ev({ id: 'wB', agentSessionId: 'sess-B', role: 'worker', ts: 5, kind: 'text', text: 'B' }),
  ];
  const rebuilt = reconstructWorkersFromTranscript(tx);
  assert.equal(rebuilt.find((w) => w.sessionId === 'sess-A')?.toolUseId, 'tool-A');
  assert.equal(rebuilt.find((w) => w.sessionId === 'sess-X')?.toolUseId, undefined);
  assert.equal(rebuilt.find((w) => w.sessionId === 'sess-B')?.toolUseId, 'tool-B');
});

const spawn = (toolArgs: Record<string, unknown>): TranscriptEvent =>
  ev({ id: 's', agentSessionId: 'orc', role: 'orchestrator', ts: 1, kind: 'tool_call', toolName: 'Task', toolArgs });

test('richerSubagent merges a label-only delta with a later description-only delta', () => {
  const merged = richerSubagent(spawn({ subagent_type: 'worker' }), spawn({ description: 'fix the bug' }));
  assert.deepEqual(subagentInfo(merged.toolArgs), { label: 'worker', description: 'fix the bug' });
});

test('richerSubagent merges a description-only delta with a later label-only delta', () => {
  const merged = richerSubagent(spawn({ description: 'fix the bug' }), spawn({ subagent_type: 'worker' }));
  assert.deepEqual(subagentInfo(merged.toolArgs), { label: 'worker', description: 'fix the bug' });
});

test('richerSubagent returns the latest event untouched when it already carries both fields', () => {
  const next = spawn({ subagent_type: 'worker', description: 'do X' });
  assert.equal(richerSubagent(spawn({ subagent_type: 'worker' }), next), next);
});

test('subagentLatest surfaces a failed tool result as a failure, not stale activity', () => {
  const out = subagentLatest({ kind: 'tool_result', text: 'command exited 1', toolName: 'Bash', isError: true });
  assert.equal(out?.head, 'Failed');
  assert.equal(out?.body, 'command exited 1');
});

test('subagentLatest maps an error event to Error and a missing latest to null', () => {
  assert.equal(subagentLatest({ kind: 'error', text: 'boom' })?.head, 'Error');
  assert.equal(subagentLatest(undefined), null);
});
