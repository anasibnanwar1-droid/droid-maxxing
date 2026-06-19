import test from 'node:test';
import assert from 'node:assert/strict';
import { reducer, initialState } from './useStore';
import type { AppState } from './useStore';
import type { TranscriptEvent } from '../types/bridge';

function delta(id: string, toolUseId: string, args: Record<string, unknown>, ts: number) {
  return {
    type: 'MISSION_TRANSCRIPT',
    event: {
      id,
      missionId: 'm1',
      agentSessionId: 'orchestrator',
      kind: 'tool_call',
      toolName: 'edit',
      toolUseId,
      toolArgs: args,
      ts,
    } as TranscriptEvent,
  } as const;
}

test('MISSION_TRANSCRIPT coalesces tool_call deltas sharing one toolUseId into one event', () => {
  let state = initialState as AppState;
  state = reducer(state, delta('d1', 'edit-1', { path: 'a.ts', new_string: 'x' }, 1));
  state = reducer(state, delta('d2', 'edit-1', { path: 'a.ts', new_string: 'xy' }, 2));
  state = reducer(state, delta('d3', 'edit-1', { path: 'a.ts', new_string: 'xyz' }, 3));

  const events = state.transcripts.m1;
  assert.equal(events.length, 1);
  // Stable id is kept from the first delta; latest args + endTs are adopted.
  assert.equal(events[0].id, 'd1');
  assert.deepEqual(events[0].toolArgs, { path: 'a.ts', new_string: 'xyz' });
  assert.equal(events[0].endTs, 3);
});

test('MISSION_TRANSCRIPT merges partial delta args instead of dropping earlier fields', () => {
  let state = initialState as AppState;
  // A Task spawn streams its fields across separate deltas; a later payload-less
  // delta must not erase the accumulated args.
  state = reducer(state, delta('d1', 'task-1', { subagent_type: 'worker' }, 1));
  state = reducer(state, delta('d2', 'task-1', { description: 'do the thing' }, 2));
  state = reducer(state, delta('d3', 'task-1', {}, 3));

  const events = state.transcripts.m1;
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'd1');
  assert.deepEqual(events[0].toolArgs, {
    subagent_type: 'worker',
    description: 'do the thing',
  });
  assert.equal(events[0].endTs, 3);
});

test('MISSION_TRANSCRIPT keeps tool_calls with distinct toolUseIds separate', () => {
  let state = initialState as AppState;
  state = reducer(state, delta('d1', 'edit-1', { path: 'a.ts' }, 1));
  state = reducer(state, delta('d2', 'edit-2', { path: 'b.ts' }, 2));

  const events = state.transcripts.m1;
  assert.equal(events.length, 2);
  assert.equal(events[0].toolUseId, 'edit-1');
  assert.equal(events[1].toolUseId, 'edit-2');
});
