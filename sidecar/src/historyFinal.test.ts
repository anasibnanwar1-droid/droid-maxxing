import test from 'node:test';
import assert from 'node:assert/strict';
import { markFinalAssistantText } from './history.js';
import type { TranscriptEvent } from './protocol.js';

function ev(id: string, kind: TranscriptEvent['kind'], extra: Partial<TranscriptEvent> = {}) {
  return {
    id,
    missionId: 'm',
    agentSessionId: 'orchestrator',
    role: 'orchestrator',
    ts: 0,
    kind,
    ...extra,
  } as TranscriptEvent;
}

test('marks the last assistant text of a turn as final, not interim texts', () => {
  const events = [
    ev('u1', 'text', { author: 'user' }),
    ev('a1', 'text'),
    ev('t1', 'tool_call'),
    ev('a2', 'text'),
  ];
  markFinalAssistantText(events);
  assert.equal(events.find((e) => e.id === 'a1')!.final, undefined);
  assert.equal(events.find((e) => e.id === 'a2')!.final, true);
});

test('a trailing compaction/tool status after the answer does not steal final', () => {
  const events = [
    ev('u1', 'text', { author: 'user' }),
    ev('a1', 'text'),
    ev('c1', 'compaction'),
    ev('s1', 'status'),
  ];
  markFinalAssistantText(events);
  // The terminal answer stays final even though non-text events follow it.
  assert.equal(events.find((e) => e.id === 'a1')!.final, true);
});

test('each turn keeps its own final answer', () => {
  const events = [
    ev('u1', 'text', { author: 'user' }),
    ev('a1', 'text'),
    ev('u2', 'text', { author: 'user' }),
    ev('a2', 'text'),
  ];
  markFinalAssistantText(events);
  assert.equal(events.find((e) => e.id === 'a1')!.final, true);
  assert.equal(events.find((e) => e.id === 'a2')!.final, true);
});
