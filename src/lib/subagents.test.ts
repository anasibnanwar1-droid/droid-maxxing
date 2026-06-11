import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEvent } from '../types/bridge';
import { workersFromLinks, reconstructWorkersFromTranscript, resolveWorkers } from './subagents';

function ev(p: Partial<TranscriptEvent> & Pick<TranscriptEvent, 'id' | 'agentSessionId' | 'role' | 'ts' | 'kind'>): TranscriptEvent {
  return { missionId: 'm1', ...p } as TranscriptEvent;
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

test('workersFromLinks preserves the exact toolUseId -> session mapping (duplicate labels)', () => {
  const workers = workersFromLinks(links);
  assert.equal(workers.find((w) => w.toolUseId === 'tool-A')?.sessionId, 'sess-B');
  assert.equal(workers.find((w) => w.toolUseId === 'tool-B')?.sessionId, 'sess-A');
});

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
