import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPermission,
  confirmationType,
  extractCompactionNotification,
  mapProgress,
  permissionSignature,
  normalizeStreamEvent,
} from './normalize.js';

test('mapProgress keeps Mission provider and spawn correlation internal for policy projection', () => {
  assert.deepEqual(
    mapProgress([
      {
        type: 'worker_started',
        timestamp: '2026-07-29T00:00:00.000Z',
        workerSessionId: 'provider-worker',
        spawnId: 'spawn-1',
        featureId: 'feature-1',
      },
    ] as never),
    [
      {
        type: 'worker_started',
        timestamp: '2026-07-29T00:00:00.000Z',
        title: undefined,
        message: undefined,
        featureId: 'feature-1',
        workerProviderSessionId: 'provider-worker',
        spawnId: 'spawn-1',
      },
    ],
  );
});

test('extractCompactionNotification detects the daemon compaction start', () => {
  assert.deepEqual(
    extractCompactionNotification({
      params: {
        notification: { type: 'droid_working_state_changed', newState: 'compacting_conversation' },
      },
    }),
    { kind: 'started', removedCount: 0 },
  );
});

test('extractCompactionNotification detects the compaction completion with removed count', () => {
  assert.deepEqual(
    extractCompactionNotification({
      params: {
        notification: { type: 'session_compacted', summaryId: 's1', removedCount: 42 },
      },
    }),
    { kind: 'completed', removedCount: 42, summaryId: 's1' },
  );
  // A missing or malformed count falls back to zero instead of NaN.
  assert.deepEqual(
    extractCompactionNotification({
      params: { notification: { type: 'session_compacted', summaryId: 's1' } },
    }),
    { kind: 'completed', removedCount: 0, summaryId: 's1' },
  );
});

test('extractCompactionNotification ignores unrelated notifications', () => {
  assert.equal(
    extractCompactionNotification({
      params: { notification: { type: 'droid_working_state_changed', newState: 'thinking' } },
    }),
    null,
  );
  assert.equal(
    extractCompactionNotification({
      params: { notification: { type: 'message', role: 'assistant' } },
    }),
    null,
  );
  assert.equal(extractCompactionNotification({}), null);
});

test('token usage maps context to the daemon threshold formula (in + out + cacheRead)', () => {
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'session_token_usage_changed',
    inclusiveTokenUsage: {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 30,
      cacheCreationTokens: 20,
    },
    lastCallTokenUsage: {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
    },
  } as never);

  // The daemon's compaction threshold checks last-call input + output +
  // cacheRead (never cacheCreation), so the meter must count the same way.
  assert.deepEqual(normalized?.tokens, {
    tokensIn: 150,
    tokensOut: 40,
    contextTokens: 17,
  });
});

test('cumulative session usage never masquerades as current context usage', () => {
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'session_token_usage_changed',
    inclusiveTokenUsage: {
      inputTokens: 1_235_355,
      outputTokens: 242_687,
      cacheReadTokens: 12_864_536,
      cacheCreationTokens: 0,
    },
    tokenUsage: {
      inputTokens: 979_933,
      outputTokens: 179_985,
      cacheReadTokens: 11_945_488,
      cacheCreationTokens: 0,
    },
  } as never);

  assert.deepEqual(normalized?.tokens, {
    tokensIn: 14_099_891,
    tokensOut: 242_687,
  });
});

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
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
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

  assert.equal(normalized?.childSession?.label, 'code-reviewer');
  assert.equal(
    normalized?.childSession?.prompt,
    'Inspect the current diff and report correctness risks.',
  );
  assert.equal(normalized?.childSession?.toolUseId, 'tool-1');
  // The spawn's transcript copy must carry the tool_call id so the chat feed
  // can collapse streaming deltas into one line and link it to the worker.
  assert.equal(normalized?.transcript?.kind, 'tool_call');
  assert.equal(normalized?.transcript?.toolUseId, 'tool-1');
});

test('stamps toolUseId on ordinary (non-subagent) tool_call transcripts', () => {
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_call',
    toolUse: {
      id: 'edit-1',
      name: 'edit',
      input: { path: 'src/app.ts', old_string: 'a', new_string: 'b' },
    },
  } as never);

  assert.equal(normalized?.childSession, undefined);
  assert.equal(normalized?.transcript?.kind, 'tool_call');
  assert.equal(normalized?.transcript?.toolUseId, 'edit-1');
});

test('stamps toolUseId on ordinary (non-subagent) tool_result transcripts', () => {
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'edit',
    toolUseId: 'edit-1',
    content: 'ok',
    isError: false,
  } as never);

  assert.equal(normalized?.childSession, undefined);
  assert.equal(normalized?.transcript?.kind, 'tool_result');
  assert.equal(normalized?.transcript?.toolUseId, 'edit-1');
});

test('captures subagent session ids from Task progress events', () => {
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_progress',
    toolUseId: 'tool-1',
    update: {
      subagentSessionId: 'worker-1',
      parameters: { subagent_type: 'code-reviewer' },
    },
  } as never);

  assert.equal(normalized?.childSession?.providerSessionId, 'worker-1');
  assert.equal(normalized?.childSession?.label, 'code-reviewer');
  assert.equal(normalized?.childSession?.toolUseId, 'tool-1');
});

test('marks Task results as correlated subagent completion', () => {
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'Task',
    toolUseId: 'tool-1',
    content: 'done',
    isError: false,
  } as never);

  assert.equal(normalized?.childSession?.done, true);
  assert.equal(normalized?.childSession?.toolUseId, 'tool-1');
});

test('captures the current SDK child session id from a successful Task result', () => {
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'Task',
    toolUseId: 'tool-current',
    content: 'session_id: provider-child-current\nCHILD_SMOKE_OK',
    isError: false,
  } as never);

  assert.equal(normalized?.childSession?.providerSessionId, 'provider-child-current');
  assert.equal(normalized?.childSession?.done, true);
  assert.equal(normalized?.childSession?.toolUseId, 'tool-current');
});

test('registers a background subagent at launch instead of completion', () => {
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'Task',
    toolUseId: 'spawn-1',
    content:
      'Task launched in background.\ntask_id: 7d32cc8f-77d5\nsession_id: 7d32cc8f-77d5\n\nUse TaskOutput to read output.',
    isError: false,
  } as never);

  assert.equal(normalized?.childSession?.providerSessionId, '7d32cc8f-77d5');
  assert.equal(normalized?.childSession?.done, false);
  // The launch acknowledgement is keyed by the spawning tool_use id.
  assert.equal(normalized?.childSession?.toolUseId, 'spawn-1');
  assert.equal(normalized?.transcript, undefined);
});

test('reads completion from TaskOutput poll results without stealing their link', () => {
  const completed = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'TaskOutput',
    toolUseId: 'poll-1',
    content:
      'Task ID: 7d32cc8f-77d5\nSubagent Type: Worker\nDescription: survey\nStatus: completed\nDuration: 208.3s\n\n<report>',
    isError: false,
  } as never);
  const running = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'TaskOutput',
    toolUseId: 'poll-2',
    content: 'Task ID: 7d32cc8f-77d5\nSubagent Type: Worker\nStatus: running\nDuration: 12.0s',
    isError: false,
  } as never);

  assert.equal(completed?.childSession?.providerSessionId, '7d32cc8f-77d5');
  assert.equal(completed?.childSession?.done, true);
  assert.equal(running?.childSession?.done, false);
  // The polling call's tool_use id is not the spawn; forwarding it would rekey
  // the child session away from its true spawn link.
  assert.equal(completed?.childSession?.toolUseId, undefined);
  assert.equal(running?.childSession?.toolUseId, undefined);
  // Poll results stay visible in the feed; only the child signal is added.
  assert.equal(completed?.transcript?.kind, 'tool_result');
});

test('a poll only completes a child when it reports a terminal status', () => {
  const poll = (content: string) =>
    normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
      type: 'tool_result',
      toolName: 'TaskOutput',
      toolUseId: 'poll-1',
      content,
      isError: false,
    } as never);

  // A long description must not push the status line out of the header window.
  const long = poll(
    `Task ID: 7d32cc8f-77d5\nSubagent Type: Worker\nDescription: ${'survey the sidecar '.repeat(40)}\nStatus: running\nDuration: 12.0s\n\nstill reading`,
  );
  assert.equal(long?.childSession?.done, false);

  // Without a status the poll says nothing about completion, so the child keeps
  // running instead of having its clock stopped on a guess.
  const statusless = poll('Task ID: 7d32cc8f-77d5\nSubagent Type: Worker\n\nstill reading');
  assert.equal(statusless?.childSession?.done, false);
});

test('a poll result carries the subagent activity it observed', () => {
  const running = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'TaskOutput',
    toolUseId: 'poll-1',
    content:
      'Task ID: 7d32cc8f-77d5\nSubagent Type: Worker\nStatus: running\nDuration: 12.0s\n\nSearching the sidecar for the admit path',
    isError: false,
  } as never);

  // An autonomous child streams nothing to the parent, so this poll is the only
  // place the UI can learn what it is doing.
  assert.equal(running?.childSession?.activity?.phase, 'Running');
  assert.equal(
    running?.childSession?.activity?.preview,
    'Searching the sidecar for the admit path',
  );

  // Header-only polls still report the phase, and never invent a preview from
  // their own header lines.
  const headerOnly = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'TaskOutput',
    toolUseId: 'poll-2',
    content: 'Task ID: 7d32cc8f-77d5\nStatus: running\n',
    isError: false,
  } as never);
  assert.equal(headerOnly?.childSession?.activity?.phase, 'Running');
  assert.equal(headerOnly?.childSession?.activity?.preview, undefined);

  // Every report field is header, including the ones that trail the status.
  const emptyBody = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'TaskOutput',
    toolUseId: 'poll-3',
    content:
      'Task ID: 7d32cc8f-77d5\nSubagent Type: Worker\nDescription: survey the sidecar\nStatus: running\nDuration: 12.0s\n\n',
    isError: false,
  } as never);
  assert.equal(emptyBody?.childSession?.activity?.preview, undefined);

  // A spawn result is the child's report, not an activity observation.
  const spawn = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'Task',
    toolUseId: 'tool-1',
    content: 'session_id: real-child\n\n<report>',
    isError: false,
  } as never);
  assert.equal(spawn?.childSession?.activity, undefined);
});

test('a report body mentioning statuses or task ids is not misparsed', () => {
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'Task',
    toolUseId: 'tool-1',
    content: 'session_id: real-child\n\nFindings:\nStatus: running\nTask ID: unrelated',
    isError: false,
  } as never);

  assert.equal(normalized?.childSession?.providerSessionId, 'real-child');
  assert.equal(normalized?.childSession?.done, true);
  assert.equal(normalized?.childSession?.toolUseId, 'tool-1');
});

test('a CRLF poll body cannot settle a child that reported no status', () => {
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'TaskOutput',
    toolUseId: 'poll-1',
    // The header ends at the blank line, CRLF or not; the body's own
    // "Status: completed" line belongs to the subagent's report.
    content:
      'Task ID: 7d32cc8f-77d5\r\nSubagent Type: Worker\r\nDuration: 12.0s\r\n\r\nStatus: completed\r\nstill reading',
    isError: false,
  } as never);

  assert.equal(normalized?.childSession?.providerSessionId, '7d32cc8f-77d5');
  assert.equal(normalized?.childSession?.done, false);
  assert.equal(normalized?.childSession?.activity?.preview, 'still reading');
});

test('only Task-family results can describe a subagent', () => {
  const shellOutput = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'Bash',
    toolUseId: 'bash-1',
    // A log, a paste, or a grep hit can open with these exact lines; treating it
    // as a poll would mint a phantom running subagent nobody spawned.
    content: 'Task ID: not-a-subagent\nStatus: running\n',
    isError: false,
  } as never);

  assert.equal(shellOutput?.childSession, undefined);
  assert.equal(shellOutput?.transcript?.kind, 'tool_result');

  // A result whose tool name never made it through still parses: dropping those
  // would lose real subagent completions.
  const unnamed = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolUseId: 'poll-1',
    content: 'Task ID: 7d32cc8f-77d5\nStatus: completed\n',
    isError: false,
  } as never);
  assert.equal(unnamed?.childSession?.providerSessionId, '7d32cc8f-77d5');
  assert.equal(unnamed?.childSession?.done, true);
});

test('ignores TaskOutput poll progress that lacks spawn params', () => {
  const normalized = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_progress',
    toolUseId: 'poll-1',
    update: { subagentSessionId: 'worker-1' },
  } as never);

  // Provider id forwards for correlation, but the polling call's id must not
  // become the child's spawn link.
  assert.equal(normalized?.childSession?.providerSessionId, 'worker-1');
  assert.equal(normalized?.childSession?.toolUseId, undefined);
});

test('does not treat child output or failed Task text as a provider session id', () => {
  const laterOutput = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'Task',
    toolUseId: 'tool-later',
    content: 'child output\nsession_id: fake-provider',
    isError: false,
  } as never);
  const failed = normalizeStreamEvent('app-session-1', 'app-session-1', 'primary', {
    type: 'tool_result',
    toolName: 'Task',
    toolUseId: 'tool-failed',
    content: 'session_id: fake-provider\nspawn failed',
    isError: true,
  } as never);

  assert.equal(laterOutput?.childSession?.providerSessionId, undefined);
  assert.equal(failed?.childSession?.providerSessionId, undefined);
});
