import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvent, isChatContent, isDiagnosticContent, isAssistantFinal } from './transcript';
import type { TranscriptEvent } from '../types/bridge';

function ev(extra: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    id: 'e',
    missionId: 'm',
    agentSessionId: 'orchestrator',
    role: 'orchestrator',
    ts: 0,
    kind: 'text',
    ...extra,
  } as TranscriptEvent;
}

test('user echo classifies as user', () => {
  assert.equal(classifyEvent(ev({ kind: 'text', author: 'user', text: 'hi' })), 'user');
});

test('assistant text classifies as assistant_chat', () => {
  assert.equal(classifyEvent(ev({ kind: 'text', text: 'answer' })), 'assistant_chat');
});

test('thinking classifies as thought', () => {
  assert.equal(classifyEvent(ev({ kind: 'thinking', text: '...' })), 'thought');
});

test('TodoWrite classifies as plan_update, not a file edit', () => {
  const e = ev({ kind: 'tool_call', toolName: 'TodoWrite', toolArgs: { todos: '1. [pending] x' } });
  assert.equal(classifyEvent(e), 'plan_update');
});

test('Task spawn classifies as subagent_event', () => {
  const e = ev({ kind: 'tool_call', toolName: 'Task', toolArgs: { subagent_type: 'worker' } });
  assert.equal(classifyEvent(e), 'subagent_event');
});

test('edit tool classifies as file_edit', () => {
  const e = ev({ kind: 'tool_call', toolName: 'Edit', toolArgs: { file_path: '/a.ts', old_str: 'a', new_str: 'b' } });
  assert.equal(classifyEvent(e), 'file_edit');
});

test('other tools classify as tool_activity', () => {
  assert.equal(classifyEvent(ev({ kind: 'tool_call', toolName: 'Grep', toolArgs: {} })), 'tool_activity');
});

test('compaction and status classify distinctly', () => {
  assert.equal(classifyEvent(ev({ kind: 'compaction' })), 'compaction');
  assert.equal(classifyEvent(ev({ kind: 'status', text: 'Working' })), 'status');
});

test('errors and failed tool results classify as error', () => {
  assert.equal(classifyEvent(ev({ kind: 'error', text: 'boom', isError: true })), 'error');
  assert.equal(classifyEvent(ev({ kind: 'tool_result', toolName: 'Execute', isError: true })), 'error');
});

test('chat vs diagnostic partitioning', () => {
  assert.equal(isChatContent('assistant_chat'), true);
  assert.equal(isChatContent('user'), true);
  assert.equal(isChatContent('plan_update'), false);
  assert.equal(isDiagnosticContent('plan_update'), true);
  assert.equal(isDiagnosticContent('tool_activity'), true);
  assert.equal(isDiagnosticContent('assistant_chat'), false);
});

test('isAssistantFinal only for flagged assistant text', () => {
  assert.equal(isAssistantFinal(ev({ kind: 'text', final: true })), true);
  assert.equal(isAssistantFinal(ev({ kind: 'text' })), false);
  assert.equal(isAssistantFinal(ev({ kind: 'text', author: 'user', final: true })), false);
});
