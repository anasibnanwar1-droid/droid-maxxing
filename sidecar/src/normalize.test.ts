import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPermission,
  confirmationType,
  normalizeNotification,
  permissionSignature,
  normalizeStreamEvent,
} from './normalize.js';

test('classifyPermission reads the SDK toolUses shape for MCP tools', () => {
  const params = {
    options: [{ value: 'proceed_once', label: 'Allow once' }],
    toolUses: [
      {
        confirmationType: 'mcp_tool',
        details: {
          type: 'mcp_tool',
          toolName: 'droidmaxx-browser___design_reference',
          impactLevel: 'low',
        },
        toolUse: {
          type: 'tool_use',
          id: 't1',
          name: 'droidmaxx-browser___design_reference',
          input: { url: 'https://skeina.app' },
        },
      },
    ],
  } as never;

  assert.equal(confirmationType(params), 'mcp_tool');
  const req = classifyPermission('m1', 'r1', params);
  assert.equal(req.kind, 'mcp');
  assert.equal(req.title, 'droidmaxx-browser · design_reference');
  assert.match(req.detail, /url: https:\/\/skeina\.app/);
  assert.match(req.detail, /Impact: low/);
  assert.equal(permissionSignature(params), 'mcp::::droidmaxx-browser___design_reference');
});

test('classifyPermission reads the SDK toolUses shape for exec', () => {
  const params = {
    options: [],
    toolUses: [
      {
        confirmationType: 'exec',
        details: { type: 'exec', command: 'rm -rf build', fullCommand: 'rm -rf build' },
        toolUse: {
          type: 'tool_use',
          id: 't2',
          name: 'Execute',
          input: { command: 'rm -rf build' },
        },
      },
    ],
  } as never;

  const req = classifyPermission('m1', 'r2', params);
  assert.equal(req.kind, 'exec');
  assert.equal(req.title, 'Run command');
  assert.equal(req.detail, 'rm -rf build');
  assert.equal(permissionSignature(params), 'exec::rm -rf build');
});

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
  assert.equal(
    normalized?.subagent?.prompt,
    'Inspect the current diff and report correctness risks.',
  );
  assert.equal(normalized?.subagent?.toolUseId, 'tool-1');
  // The spawn's transcript copy must carry the tool_call id so the chat feed
  // can collapse streaming deltas into one line and link it to the worker.
  assert.equal(normalized?.transcript?.kind, 'tool_call');
  assert.equal(normalized?.transcript?.toolUseId, 'tool-1');
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

test('maps daemon compaction working state to an active status line', () => {
  const normalized = normalizeStreamEvent('mission-1', 'mission-1', 'orchestrator', {
    type: 'working_state_changed',
    state: 'compacting_conversation',
  } as never);

  assert.equal(normalized?.transcript?.kind, 'status');
  assert.equal(normalized?.transcript?.text, 'Compacting conversation...');
  assert.equal(normalized?.transcript?.compactType, 'auto');
});

test('maps daemon compacted notification to a completion status line', () => {
  const normalized = normalizeNotification('mission-1', 'mission-1', 'orchestrator', {
    notification: { type: 'session_compacted', removedCount: 4 },
  });

  assert.equal(normalized[0]?.transcript?.kind, 'status');
  assert.equal(normalized[0]?.transcript?.text, 'Compaction complete. Removed 4 messages.');
  assert.equal(normalized[0]?.transcript?.compactType, 'auto');
});

test('token usage updates do not treat cumulative totals as context usage', () => {
  const normalized = normalizeStreamEvent('mission-1', 'mission-1', 'orchestrator', {
    type: 'token_usage_update',
    tokenUsage: {
      inputTokens: 10_603_766,
      outputTokens: 78_367,
      cacheReadTokens: 10,
      cacheCreationTokens: 20,
    },
  } as never);

  assert.equal(normalized?.tokens?.tokensIn, 10_603_796);
  assert.equal(normalized?.tokens?.tokensOut, 78_367);
  assert.equal(normalized?.tokens?.contextTokens, undefined);
});

test('token usage updates keep explicit last-call context usage', () => {
  const normalized = normalizeStreamEvent('mission-1', 'mission-1', 'orchestrator', {
    type: 'token_usage_update',
    tokenUsage: {
      inputTokens: 10_603_766,
      outputTokens: 78_367,
    },
    lastCallTokenUsage: {
      inputTokens: 40_000,
      cacheReadTokens: 1_000,
    },
  } as never);

  assert.equal(normalized?.tokens?.tokensIn, 10_603_766);
  assert.equal(normalized?.tokens?.tokensOut, 78_367);
  assert.equal(normalized?.tokens?.contextTokens, 41_000);
});
