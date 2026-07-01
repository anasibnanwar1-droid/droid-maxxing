import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isSafeCompactionBoundary,
  toolUseIdOf,
  updateToolsInFlight,
  type StreamToolEvent,
} from './compactionBoundary.js';

test('toolUseIdOf returns a trimmed id or undefined', () => {
  assert.equal(toolUseIdOf('t1'), 't1');
  assert.equal(toolUseIdOf('  t1  '), 't1');
  assert.equal(toolUseIdOf(''), undefined);
  assert.equal(toolUseIdOf('   '), undefined);
  assert.equal(toolUseIdOf(undefined), undefined);
  assert.equal(toolUseIdOf(42), undefined);
});

test('updateToolsInFlight adds on tool_call/tool_call_delta and removes on tool_result', () => {
  const inFlight = new Set<string>();
  updateToolsInFlight(inFlight, { type: 'tool_call', toolUse: { id: 't1' } });
  assert.deepEqual([...inFlight], ['t1']);
  // A streaming delta for the same tool must not double-count.
  updateToolsInFlight(inFlight, { type: 'tool_call_delta', toolUse: { id: 't1' } });
  assert.deepEqual([...inFlight], ['t1']);
  updateToolsInFlight(inFlight, { type: 'tool_result', toolUseId: 't1' });
  assert.equal(inFlight.size, 0);
});

test('updateToolsInFlight tracks parallel tools independently', () => {
  const inFlight = new Set<string>();
  updateToolsInFlight(inFlight, { type: 'tool_call', toolUse: { id: 'a' } });
  updateToolsInFlight(inFlight, { type: 'tool_call', toolUse: { id: 'b' } });
  assert.equal(inFlight.size, 2);
  updateToolsInFlight(inFlight, { type: 'tool_result', toolUseId: 'a' });
  assert.deepEqual([...inFlight], ['b']);
  updateToolsInFlight(inFlight, { type: 'tool_result', toolUseId: 'b' });
  assert.equal(inFlight.size, 0);
});

test('updateToolsInFlight resolves a tool_result that carries its id under toolUse.id', () => {
  const inFlight = new Set<string>();
  updateToolsInFlight(inFlight, { type: 'tool_call', toolUse: { id: 't1' } });
  // Some results carry the id under toolUse.id rather than toolUseId; the read
  // is symmetric so the in-flight tool is still cleared.
  updateToolsInFlight(inFlight, { type: 'tool_result', toolUse: { id: 't1' } });
  assert.equal(inFlight.size, 0);
});

test('a streaming delta without an id yet does not block a boundary', () => {
  const inFlight = new Set<string>();
  // A partial tool_call_delta before its id streams in must not be treated as a
  // tracked in-flight tool (the id arrives on a later delta or the committed call).
  updateToolsInFlight(inFlight, { type: 'tool_call_delta' });
  assert.equal(isSafeCompactionBoundary({ type: 'tool_result', toolUseId: 't1' }, inFlight), true);
});

test('a committed id-less tool_call blocks a parallel sibling boundary', () => {
  const inFlight = new Set<string>();
  // A committed tool_call we cannot key is still a tool in flight, so a parallel
  // keyed sibling resolving must NOT be mistaken for a safe boundary.
  updateToolsInFlight(inFlight, { type: 'tool_call' });
  updateToolsInFlight(inFlight, { type: 'tool_call', toolUse: { id: 'sibling' } });
  updateToolsInFlight(inFlight, { type: 'tool_result', toolUseId: 'sibling' });
  assert.equal(
    isSafeCompactionBoundary({ type: 'tool_result', toolUseId: 'sibling' }, inFlight),
    false,
  );
  // A result we never saw a keyed call for is a harmless no-op delete.
  updateToolsInFlight(inFlight, { type: 'tool_result', toolUseId: 'ghost' });
});

test('updateToolsInFlight ignores non-tool events', () => {
  const inFlight = new Set<string>();
  for (const type of ['thinking_text_delta', 'assistant_text_delta', 'result', undefined]) {
    updateToolsInFlight(inFlight, { type } as StreamToolEvent);
  }
  assert.equal(inFlight.size, 0);
});

test('isSafeCompactionBoundary is true only on a tool_result that empties the set', () => {
  const empty = new Set<string>();
  assert.equal(isSafeCompactionBoundary({ type: 'tool_result', toolUseId: 't1' }, empty), true);

  const busy = new Set<string>(['t2']);
  // A tool_result while another tool is still in flight is NOT a boundary.
  assert.equal(isSafeCompactionBoundary({ type: 'tool_result', toolUseId: 't1' }, busy), false);
});

test('isSafeCompactionBoundary rejects mid-tool, mid-reasoning, and mid-response events', () => {
  const empty = new Set<string>();
  for (const type of [
    'tool_call',
    'tool_call_delta',
    'thinking_text_delta',
    'assistant_text_delta',
    'result',
    undefined,
  ]) {
    assert.equal(isSafeCompactionBoundary({ type } as StreamToolEvent, empty), false);
  }
});

test('a tool_call then its tool_result forms exactly one safe boundary', () => {
  const inFlight = new Set<string>();
  const call: StreamToolEvent = { type: 'tool_call', toolUse: { id: 't1' } };
  const result: StreamToolEvent = { type: 'tool_result', toolUseId: 't1' };

  updateToolsInFlight(inFlight, call);
  assert.equal(isSafeCompactionBoundary(call, inFlight), false);

  updateToolsInFlight(inFlight, result);
  assert.equal(isSafeCompactionBoundary(result, inFlight), true);
});
