import test from 'node:test';
import assert from 'node:assert/strict';
import type { TranscriptEvent } from '../types/bridge';
import {
  childSessionActivityForTarget,
  childSessionIdForFeature,
  childSessionLabel,
  childSelectionForFeature,
  childSessionLatest,
  childSessionMeta,
  childRuntimeSubmitTarget,
  commitChildPromptAfterBaseline,
  findChildSessionForTarget,
  mergeChildSessionSpawn,
  orderedChildSessions,
  selectedChildForParent,
  shouldOpenSelectedChild,
  transcriptForVisibleSession,
  visibleSessionCanCompact,
  visibleSessionIsPending,
  visibleSessionTarget,
} from './childSessions';
import { childSessionInfo } from './tools';

function ev(
  p: Partial<TranscriptEvent> &
    Pick<TranscriptEvent, 'id' | 'sourceSessionId' | 'role' | 'ts' | 'kind'>,
): TranscriptEvent {
  return { appSessionId: 'app-1', ...p } as TranscriptEvent;
}

const spawn = (toolArgs: Record<string, unknown>): TranscriptEvent =>
  ev({
    id: 's',
    sourceSessionId: 'orc',
    role: 'primary',
    ts: 1,
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs,
  });

test('mergeChildSessionSpawn merges a label-only delta with a later description-only delta', () => {
  const merged = mergeChildSessionSpawn(
    spawn({ subagent_type: 'worker' }),
    spawn({ description: 'fix the bug' }),
  );
  assert.deepEqual(childSessionInfo(merged.toolArgs), {
    label: 'worker',
    description: 'fix the bug',
  });
});

test('mergeChildSessionSpawn merges a description-only delta with a later label-only delta', () => {
  const merged = mergeChildSessionSpawn(
    spawn({ description: 'fix the bug' }),
    spawn({ subagent_type: 'worker' }),
  );
  assert.deepEqual(childSessionInfo(merged.toolArgs), {
    label: 'worker',
    description: 'fix the bug',
  });
});

test('mergeChildSessionSpawn returns the latest event untouched when it already carries both fields', () => {
  const next = spawn({ subagent_type: 'worker', description: 'do X' });
  assert.equal(mergeChildSessionSpawn(spawn({ subagent_type: 'worker' }), next), next);
});

test('childSessionLatest surfaces a failed tool result as a failure, not stale activity', () => {
  const out = childSessionLatest({
    kind: 'tool_result',
    text: 'command exited 1',
    toolName: 'Bash',
    isError: true,
  });
  assert.equal(out?.head, 'Failed');
  assert.equal(out?.body, 'command exited 1');
});

test('childSessionLatest maps an error event to Error and a missing latest to null', () => {
  assert.equal(childSessionLatest({ kind: 'error', text: 'boom' })?.head, 'Error');
  assert.equal(childSessionLatest(undefined), null);
});

test('selected child targeting is parent-scoped and independent of session mode', () => {
  const child = {
    parentAppSessionId: 'mission-parent',
    childSessionId: 'worker-logical',
    role: 'validator' as const,
    status: 'paused' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
  };
  const children = { 'mission-parent': { 'worker-logical': child } };

  assert.equal(
    selectedChildForParent(
      'mission-parent',
      { parentAppSessionId: 'mission-parent', childSessionId: 'worker-logical' },
      children,
    ),
    child,
  );
  assert.equal(
    selectedChildForParent(
      'other-parent',
      { parentAppSessionId: 'mission-parent', childSessionId: 'worker-logical' },
      children,
    ),
    undefined,
  );
});

test('switching to a feature without an exact child clears the previous prompt target', () => {
  const child = {
    parentAppSessionId: 'mission-parent',
    childSessionId: 'worker-a',
    role: 'worker' as const,
    status: 'running' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
  };
  const progress = [
    {
      id: 'progress-a',
      timestamp: '2026-07-30T00:00:00.000Z',
      type: 'worker_started' as const,
      title: 'Feature A worker',
      featureId: 'feature-a',
      workerChildSessionId: 'worker-a',
    },
    {
      id: 'progress-b',
      timestamp: '2026-07-30T00:00:01.000Z',
      type: 'worker_started' as const,
      title: 'Feature B worker',
      featureId: 'feature-b',
      workerChildSessionId: 'missing-worker-b',
    },
  ];

  assert.equal(childSelectionForFeature(progress, [child], 'feature-a'), 'worker-a');
  assert.equal(childSelectionForFeature(progress, [child], 'feature-b'), null);
  assert.equal(childSelectionForFeature(progress, [child], 'feature-without-progress'), null);
  assert.deepEqual(
    visibleSessionTarget(
      'mission-parent',
      null,
      { 'mission-parent': { 'worker-a': child } },
      {
        'mission-parent': {
          'worker-a': { state: 'ready', requestId: 'ready-a', runtimeGeneration: 1 },
        },
      },
    ),
    { kind: 'primary' },
  );
});

test('child ordering gives unlabeled siblings one stable label across surfaces', () => {
  const later = {
    parentAppSessionId: 'mission-parent',
    childSessionId: 'worker-later',
    role: 'worker' as const,
    status: 'running' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
    startedAt: 20,
  };
  const earlier = {
    ...later,
    childSessionId: 'worker-earlier',
    startedAt: 10,
  };

  const ordered = orderedChildSessions([later, earlier]);
  assert.deepEqual(
    ordered.map((childSession, index) => [
      childSession.childSessionId,
      childSessionLabel(childSession, index),
    ]),
    [
      ['worker-earlier', 'Worker 1'],
      ['worker-later', 'Worker 2'],
    ],
  );
});

test('historical running child activity is paused without an authoritative runtime', () => {
  const child = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    role: 'worker' as const,
    status: 'running' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
    spawnLink: { kind: 'tool-use' as const, id: 'tool-a' },
  };

  assert.equal(
    childSessionActivityForTarget([child], [], {}, { toolUseId: 'tool-a' })?.status,
    'paused',
  );
  assert.equal(
    childSessionActivityForTarget(
      [child],
      [],
      { 'parent-a': { 'child-a': { available: true } } },
      { toolUseId: 'tool-a' },
    )?.status,
    'running',
  );
});

test('visible child actionability is exact and readiness-gated', () => {
  const running = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    role: 'worker' as const,
    status: 'running' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
  };
  const children = {
    'parent-a': { 'child-a': running },
    'parent-b': { 'child-a': { ...running, parentAppSessionId: 'parent-b' } },
  };
  const ready = visibleSessionTarget(
    'parent-a',
    { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
    children,
    {
      'parent-a': {
        'child-a': { state: 'ready', requestId: 'request-a', runtimeGeneration: 4 },
      },
    },
  );
  assert.equal(ready.kind, 'child');
  if (ready.kind !== 'child') assert.fail('expected exact child target');
  assert.equal(ready.child.parentAppSessionId, 'parent-a');
  assert.equal(ready.canSend, true);
  assert.equal(ready.canInterrupt, true);
  assert.equal(ready.settingsReadiness, 'ready');

  const wrongParent = visibleSessionTarget(
    'parent-b',
    { parentAppSessionId: 'parent-a', childSessionId: 'child-a' },
    children,
    {},
  );
  assert.deepEqual(wrongParent, { kind: 'primary' });
});

test('completed and historical children stay selected while actions are disabled', () => {
  const completed = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    role: 'worker' as const,
    status: 'completed' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
  };
  const selection = { parentAppSessionId: 'parent-a', childSessionId: 'child-a' };
  const children = { 'parent-a': { 'child-a': completed } };

  for (const access of [
    { state: 'ready' as const, requestId: 'ready', runtimeGeneration: 2 },
    { state: 'history' as const, requestId: 'history' },
  ]) {
    const target = visibleSessionTarget('parent-a', selection, children, {
      'parent-a': { 'child-a': access },
    });
    assert.equal(target.kind, 'child');
    if (target.kind !== 'child') assert.fail('expected selected child target');
    assert.equal(target.childSessionId, 'child-a');
    assert.equal(target.canSend, false);
    assert.equal(target.canInterrupt, false);
    assert.equal(target.settingsReadiness, 'failed');
  }

  const beforeHistorySettlement = visibleSessionTarget('parent-a', selection, children, {});
  assert.equal(beforeHistorySettlement.kind, 'child');
  if (beforeHistorySettlement.kind !== 'child') assert.fail('expected selected child target');
  assert.equal(beforeHistorySettlement.settingsReadiness, 'failed');
});

test('visible pending state never inherits liveness across the parent-child boundary', () => {
  const running = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    role: 'worker' as const,
    status: 'running' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
  };
  const selection = { parentAppSessionId: 'parent-a', childSessionId: 'child-a' };
  const children = { 'parent-a': { 'child-a': running } };
  const readyChild = visibleSessionTarget('parent-a', selection, children, {
    'parent-a': {
      'child-a': { state: 'ready', requestId: 'ready', runtimeGeneration: 2 },
    },
  });
  const historicalChild = visibleSessionTarget('parent-a', selection, children, {
    'parent-a': { 'child-a': { state: 'history', requestId: 'history' } },
  });

  assert.equal(visibleSessionIsPending(readyChild, false, null), true);
  assert.equal(visibleSessionIsPending(historicalChild, true, 'primary'), false);
  assert.equal(visibleSessionIsPending({ kind: 'primary' }, true, 'primary'), true);
  assert.equal(visibleSessionIsPending({ kind: 'primary' }, true, 'child-a'), false);
  assert.equal(visibleSessionCanCompact(readyChild), false);
  assert.equal(visibleSessionCanCompact(historicalChild), false);
  assert.equal(visibleSessionCanCompact({ kind: 'primary' }), true);
});

test('child prompt commit suppresses every effect when the runtime closes during git baseline', async () => {
  const child = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    role: 'worker' as const,
    status: 'running' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
  };
  const selection = { parentAppSessionId: 'parent-a', childSessionId: 'child-a' };
  const children = { 'parent-a': { 'child-a': child } };
  let current = visibleSessionTarget('parent-a', selection, children, {
    'parent-a': {
      'child-a': { state: 'ready', requestId: 'ready', runtimeGeneration: 7 },
    },
  });
  const captured = childRuntimeSubmitTarget(current);
  assert.ok(captured);
  let releaseBaseline = (): void => undefined;
  const baseline = new Promise<void>((resolve) => {
    releaseBaseline = resolve;
  });
  const composerRevision = 1;
  let transcriptEffects = 0;
  let resetEffects = 0;
  let commandEffects = 0;
  const submission = commitChildPromptAfterBaseline({
    capturedTarget: captured,
    capturedComposerRevision: composerRevision,
    waitForBaseline: () => baseline,
    currentTarget: () => current,
    currentComposerRevision: () => composerRevision,
    appendTranscript: () => {
      transcriptEffects += 1;
    },
    resetComposer: () => {
      resetEffects += 1;
    },
    sendCommand: () => {
      commandEffects += 1;
    },
  });
  current = visibleSessionTarget('parent-a', selection, children, {
    'parent-a': {
      'child-a': { state: 'closed', requestId: null },
    },
  });
  releaseBaseline();

  assert.equal(await submission, false);
  assert.equal(composerRevision, 1);
  assert.equal(transcriptEffects, 0);
  assert.equal(resetEffects, 0);
  assert.equal(commandEffects, 0);
});

test('child prompt commit rejects a replacement runtime with the same logical child', async () => {
  const child = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    role: 'worker' as const,
    status: 'running' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
  };
  const selection = { parentAppSessionId: 'parent-a', childSessionId: 'child-a' };
  const children = { 'parent-a': { 'child-a': child } };
  const ready = (runtimeGeneration: number) =>
    visibleSessionTarget('parent-a', selection, children, {
      'parent-a': {
        'child-a': { state: 'ready', requestId: 'ready', runtimeGeneration },
      },
    });
  let current = ready(11);
  const captured = childRuntimeSubmitTarget(current);
  assert.ok(captured);
  let releaseBaseline = (): void => undefined;
  const baseline = new Promise<void>((resolve) => {
    releaseBaseline = resolve;
  });

  let effects = 0;
  const admitted = commitChildPromptAfterBaseline({
    capturedTarget: captured,
    capturedComposerRevision: 1,
    waitForBaseline: () => baseline,
    currentTarget: () => current,
    currentComposerRevision: () => 1,
    appendTranscript: () => {
      effects += 1;
    },
    resetComposer: () => {
      effects += 1;
    },
    sendCommand: () => {
      effects += 1;
    },
  });
  current = ready(12);
  releaseBaseline();

  assert.equal(await admitted, false);
  assert.equal(effects, 0);
});

test('child prompt commit preserves a composer revised during git baseline', async () => {
  const child = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'child-a',
    role: 'worker' as const,
    status: 'running' as const,
    modelId: 'model-default',
    transcriptAvailable: true,
  };
  const selection = { parentAppSessionId: 'parent-a', childSessionId: 'child-a' };
  const target = visibleSessionTarget(
    'parent-a',
    selection,
    { 'parent-a': { 'child-a': child } },
    {
      'parent-a': {
        'child-a': { state: 'ready', requestId: 'ready', runtimeGeneration: 4 },
      },
    },
  );
  const captured = childRuntimeSubmitTarget(target);
  assert.ok(captured);
  let composerRevision = 8;
  let transcriptEffects = 0;
  let resetEffects = 0;
  let commandEffects = 0;
  let releaseBaseline = (): void => undefined;
  const baseline = new Promise<void>((resolve) => {
    releaseBaseline = resolve;
  });
  const submission = commitChildPromptAfterBaseline({
    capturedTarget: captured,
    capturedComposerRevision: composerRevision,
    waitForBaseline: () => baseline,
    currentTarget: () => target,
    currentComposerRevision: () => composerRevision,
    appendTranscript: () => {
      transcriptEffects += 1;
    },
    resetComposer: () => {
      resetEffects += 1;
    },
    sendCommand: () => {
      commandEffects += 1;
    },
  });

  composerRevision += 2;
  releaseBaseline();

  assert.equal(await submission, true);
  assert.equal(transcriptEffects, 1);
  assert.equal(resetEffects, 0);
  assert.equal(commandEffects, 1);
});

test('primary and exact child transcripts remain isolated while switching', () => {
  const transcript = [
    ev({
      id: 'user',
      sourceSessionId: 'user',
      role: 'primary',
      author: 'user',
      ts: 1,
      kind: 'text',
      text: 'primary prompt',
    }),
    ev({
      id: 'primary',
      sourceSessionId: 'parent-a',
      role: 'primary',
      ts: 2,
      kind: 'text',
      text: 'primary answer',
    }),
    ev({
      id: 'child-a',
      sourceSessionId: 'child-a',
      role: 'worker',
      ts: 3,
      kind: 'text',
      text: 'child A output',
    }),
    ev({
      id: 'child-b',
      sourceSessionId: 'child-b',
      role: 'worker',
      ts: 4,
      kind: 'text',
      text: 'child B output',
    }),
  ];

  assert.deepEqual(
    transcriptForVisibleSession(transcript, null).map((event) => event.id),
    ['user', 'primary'],
  );
  assert.deepEqual(
    transcriptForVisibleSession(transcript, 'child-a').map((event) => event.id),
    ['child-a'],
  );
  assert.deepEqual(
    transcriptForVisibleSession(transcript, 'child-b').map((event) => event.id),
    ['child-b'],
  );
});

test('child open retries require explicit reselection after terminal access', () => {
  assert.equal(shouldOpenSelectedChild(undefined), true);
  assert.equal(shouldOpenSelectedChild({ state: 'opening', requestId: 'request-a' }), false);
  assert.equal(
    shouldOpenSelectedChild({
      state: 'ready',
      requestId: 'request-a',
      runtimeGeneration: 2,
    }),
    false,
  );
  assert.equal(shouldOpenSelectedChild({ state: 'history', requestId: 'request-a' }), false);
  assert.equal(shouldOpenSelectedChild({ state: 'failed', requestId: 'request-a' }), false);
  assert.equal(shouldOpenSelectedChild({ state: 'closed', requestId: null }), false);
});

test('feature navigation uses only the latest exact progress child link', () => {
  assert.equal(
    childSessionIdForFeature(
      [
        {
          type: 'worker_started',
          timestamp: '2026-07-29T10:00:00.000Z',
          featureId: 'feature-a',
          workerChildSessionId: 'worker-a',
        },
        {
          type: 'worker_started',
          timestamp: '2026-07-29T10:01:00.000Z',
          featureId: 'feature-b',
          workerChildSessionId: 'worker-b',
        },
        {
          type: 'worker_restarted',
          timestamp: '2026-07-29T10:02:00.000Z',
          featureId: 'feature-a',
          workerChildSessionId: 'worker-a-2',
        },
      ],
      'feature-a',
    ),
    'worker-a-2',
  );
  assert.equal(
    childSessionIdForFeature(
      [
        {
          type: 'feature_started',
          timestamp: '2026-07-29T10:00:00.000Z',
          featureId: 'feature-a',
        },
      ],
      'feature-a',
    ),
    undefined,
  );

  const childSessionId = childSessionIdForFeature(
    [
      {
        type: 'worker_started',
        timestamp: '2026-07-29T10:00:00.000Z',
        featureId: 'feature-a',
        workerChildSessionId: 'worker-a',
      },
    ],
    'feature-a',
  );
  const siblingEvents = [
    ev({
      id: 'worker-a-tool',
      sourceSessionId: 'worker-a',
      role: 'worker',
      ts: 1,
      kind: 'tool_call',
      toolName: 'Bash',
    }),
    ev({
      id: 'worker-b-tool',
      sourceSessionId: 'worker-b',
      role: 'worker',
      ts: 2,
      kind: 'tool_call',
      toolName: 'Bash',
    }),
  ];
  assert.deepEqual(
    transcriptForVisibleSession(siblingEvents, childSessionId ?? null).map((event) => event.id),
    ['worker-a-tool'],
  );
});

test('child display preserves same-role sibling identity and required metadata', () => {
  const first = {
    parentAppSessionId: 'parent-a',
    childSessionId: 'worker-a',
    role: 'worker' as const,
    status: 'running' as const,
    modelId: 'model-a',
    reasoningEffort: 'high' as const,
    transcriptAvailable: true,
  };
  const second = {
    ...first,
    childSessionId: 'worker-b',
    status: 'completed' as const,
    transcriptAvailable: false,
  };

  assert.equal(childSessionLabel(first, 0), 'Worker 1');
  assert.equal(childSessionLabel(second, 1), 'Worker 2');
  assert.equal(
    childSessionMeta(first, 'Model A'),
    'worker · running · Model A · high · transcript',
  );
  assert.equal(
    childSessionMeta(second, 'Model A'),
    'worker · completed · Model A · high · no transcript',
  );
});

test('spawn navigation resolves only an exact tool-use link', () => {
  const childSessions = [
    {
      parentAppSessionId: 'parent-a',
      childSessionId: 'worker-a',
      role: 'worker' as const,
      status: 'completed' as const,
      label: 'same label',
      modelId: 'model-a',
      spawnLink: { kind: 'tool-use' as const, id: 'tool-a' },
      transcriptAvailable: true,
    },
    {
      parentAppSessionId: 'parent-a',
      childSessionId: 'worker-b',
      role: 'worker' as const,
      status: 'completed' as const,
      label: 'same label',
      modelId: 'model-a',
      spawnLink: { kind: 'tool-use' as const, id: 'tool-b' },
      transcriptAvailable: true,
    },
  ];

  assert.equal(
    findChildSessionForTarget(childSessions, {
      toolUseId: 'tool-b',
      label: 'same label',
    })?.childSessionId,
    'worker-b',
  );
  assert.equal(
    findChildSessionForTarget(childSessions, {
      label: 'same label',
    }),
    undefined,
  );
});
