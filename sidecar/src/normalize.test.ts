import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPermission,
  confirmationType,
  isSessionCompactedNotification,
  mapFeature,
  mapProgress,
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

test('mapFeature and mapProgress tolerate partial SDK payloads', () => {
  assert.deepEqual(
    mapFeature({
      id: 'feature-1',
      description: 'Ship compaction',
      status: 'in_progress',
      skillName: 'runtime',
      fulfills: ['issue-18'],
      milestone: 'M1',
      workerSessionIds: ['worker-1'],
    } as never),
    {
      id: 'feature-1',
      description: 'Ship compaction',
      status: 'in_progress',
      skillName: 'runtime',
      preconditions: [],
      expectedBehavior: [],
      verificationSteps: [],
      fulfills: ['issue-18'],
      milestone: 'M1',
      workerSessionIds: ['worker-1'],
      currentWorkerSessionId: null,
      completedWorkerSessionId: null,
    },
  );

  const progress = mapProgress([
    { type: 'search', timestamp: 'now', summary: 'Read files', featureId: 'feature-1' },
    { title: 'Fallback timestamp', workerSessionId: 'worker-1' },
  ] as never);

  assert.equal(typeof progress[1]?.timestamp, 'string');
  assert.deepEqual(progress, [
    {
      type: 'search',
      timestamp: 'now',
      title: undefined,
      message: 'Read files',
      featureId: 'feature-1',
      workerSessionId: undefined,
    },
    {
      type: 'entry',
      timestamp: progress[1]?.timestamp,
      title: 'Fallback timestamp',
      message: undefined,
      featureId: undefined,
      workerSessionId: 'worker-1',
    },
  ]);
});

test('classifyPermission covers non-tool permission shapes', () => {
  const specParams = {
    confirmations: [
      {
        confirmation: {
          type: 'exit_spec_mode',
          title: 'Review plan',
          plan: 'Plan body',
          optionNames: ['proceed_once'],
        },
      },
    ],
  } as never;
  assert.deepEqual(classifyPermission('m1', 'spec', specParams), {
    missionId: 'm1',
    requestId: 'spec',
    kind: 'spec',
    title: 'Review plan',
    detail: 'Plan body',
    plan: 'Plan body',
    options: ['proceed_once'],
    raw: specParams,
  });

  const proposal = classifyPermission('m1', 'proposal', {
    confirmation: { type: 'propose_mission', proposal: 'Mission plan' },
  } as never);
  assert.equal(proposal.kind, 'mission_plan');
  assert.equal(proposal.detail, 'Mission plan');

  const start = classifyPermission('m1', 'start', {
    confirmation: { type: 'start_mission_run', runningMissionCount: 2 },
  } as never);
  assert.equal(start.title, 'Start mission run');
  assert.equal(start.detail, 'Running missions: 2');
});

test('classifyPermission and signatures cover file and fallback permissions', () => {
  const create = { confirmation: { type: 'create', fileName: 'new.ts' } } as never;
  assert.equal(classifyPermission('m1', 'create', create).title, 'Create file');
  assert.equal(permissionSignature(create), 'create::new.ts');

  const edit = { confirmation: { type: 'edit', filePath: 'src/app.ts' } } as never;
  assert.equal(classifyPermission('m1', 'edit', edit).title, 'Edit file');
  assert.equal(permissionSignature(edit), 'edit::src/app.ts');

  const patch = { confirmation: { type: 'apply_patch', filePath: 'src/app.ts' } } as never;
  assert.equal(classifyPermission('m1', 'patch', patch).detail, 'src/app.ts');
  assert.equal(permissionSignature(patch), 'apply_patch::src/app.ts');

  const external = { confirmation: { type: 'mcp_tool', serverName: 'browser' } } as never;
  assert.equal(classifyPermission('m1', 'mcp', external).title, 'browser tool');

  const unknown = { confirmation: { type: 'unknown', value: 1 } } as never;
  assert.equal(classifyPermission('m1', 'unknown', unknown).kind, 'other');
  assert.equal(permissionSignature(unknown), '');
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

test('keeps failed Task results visible while marking subagent completion', () => {
  const normalized = normalizeStreamEvent('mission-1', 'mission-1', 'orchestrator', {
    type: 'tool_result',
    toolName: 'Task',
    toolUseId: 'tool-1',
    subagentSessionId: 'worker-1',
    content: { error: 'spawn failed' },
    isError: true,
  } as never);

  assert.equal(normalized?.subagent?.done, true);
  assert.equal(normalized?.transcript?.kind, 'tool_result');
  assert.equal(normalized?.transcript?.isError, true);
  assert.equal(normalized?.transcript?.text, '{"error":"spawn failed"}');
});

test('maps common stream events into transcript and mission updates', () => {
  assert.equal(
    normalizeStreamEvent('m1', 'm1', 'orchestrator', {
      type: 'assistant_text_delta',
      text: 'hello',
    } as never)?.transcript?.kind,
    'text',
  );
  assert.equal(
    normalizeStreamEvent('m1', 'm1', 'orchestrator', {
      type: 'thinking_text_delta',
      text: 'thinking',
    } as never)?.transcript?.kind,
    'thinking',
  );
  assert.equal(
    normalizeStreamEvent('m1', 'm1', 'orchestrator', {
      type: 'error',
      message: 'boom',
    } as never)?.transcript?.isError,
    true,
  );
  assert.equal(
    normalizeStreamEvent('m1', 'm1', 'orchestrator', {
      type: 'mission_state_changed',
      state: 'running',
    } as never)?.missionState,
    'running',
  );
  assert.equal(
    normalizeStreamEvent('m1', 'm1', 'orchestrator', {
      type: 'mission_worker_started',
      workerSessionId: 'worker-1',
    } as never)?.worker?.event,
    'started',
  );
  assert.equal(
    normalizeStreamEvent('m1', 'm1', 'orchestrator', {
      type: 'mission_worker_completed',
      workerSessionId: 'worker-1',
      exitCode: 0,
    } as never)?.worker?.event,
    'completed',
  );
  assert.equal(
    normalizeStreamEvent('m1', 'm1', 'orchestrator', { type: 'result' } as never)?.done,
    true,
  );
});

test('ignores non-compaction working states and empty tool progress', () => {
  assert.equal(
    normalizeStreamEvent('m1', 'm1', 'orchestrator', {
      type: 'working_state_changed',
      state: 'thinking',
    } as never),
    null,
  );
  assert.equal(
    normalizeStreamEvent('m1', 'm1', 'orchestrator', {
      type: 'tool_progress',
      update: { parameters: {} },
    } as never),
    null,
  );
});

test('maps unknown subagent session events without leaking main transcript', () => {
  const normalized = normalizeStreamEvent('m1', 'm1', 'orchestrator', {
    type: 'unknown_event',
    subagentSessionId: 'worker-1',
    toolUseId: 'tool-1',
  } as never);

  assert.equal(normalized?.subagent?.sessionId, 'worker-1');
  assert.equal(normalized?.subagent?.toolUseId, 'tool-1');
  assert.equal(normalized?.transcript, undefined);
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

test('detects compacted notifications across wrapper shapes', () => {
  assert.equal(isSessionCompactedNotification({ type: 'session_compacted' }), true);
  assert.equal(
    isSessionCompactedNotification({ params: { notification: { type: 'session_compacted' } } }),
    true,
  );
  assert.equal(isSessionCompactedNotification({ notification: { type: 'other' } }), false);
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
