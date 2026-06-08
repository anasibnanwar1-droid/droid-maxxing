import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStreamEvent } from './normalize.js';

test('captures Task prompt metadata before the subagent session id exists', () => {
  const normalized = normalizeStreamEvent('mission-1', 'mission-1', 'orchestrator', {
    type: 'tool_call',
    toolUse: {
      id: 'tool-1',
      name: 'Task',
      input: {
        subagent_type: 'code-reviewer',
        description: 'Review the patch',
        prompt: 'Inspect the current diff and report correctness risks.',
      },
    },
  } as never);

  assert.equal(normalized?.subagent?.label, 'code-reviewer');
  assert.equal(normalized?.subagent?.prompt, 'Inspect the current diff and report correctness risks.');
  assert.equal(normalized?.subagent?.toolUseId, 'tool-1');
});

test('captures subagent session ids from Task progress events', () => {
  const normalized = normalizeStreamEvent('mission-1', 'mission-1', 'orchestrator', {
    type: 'tool_progress',
    toolUseId: 'tool-1',
    update: {
      subagentSessionId: 'worker-1',
      parameters: { subagent_type: 'code-reviewer' },
    },
  } as never);

  assert.equal(normalized?.subagent?.sessionId, 'worker-1');
  assert.equal(normalized?.subagent?.label, 'code-reviewer');
  assert.equal(normalized?.subagent?.toolUseId, 'tool-1');
});

test('marks Task results as correlated subagent completion', () => {
  const normalized = normalizeStreamEvent('mission-1', 'mission-1', 'orchestrator', {
    type: 'tool_result',
    toolName: 'Task',
    toolUseId: 'tool-1',
    content: 'done',
    isError: false,
  } as never);

  assert.equal(normalized?.subagent?.done, true);
  assert.equal(normalized?.subagent?.toolUseId, 'tool-1');
});
