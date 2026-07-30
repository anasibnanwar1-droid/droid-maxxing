import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueuedPrompt } from '../hooks/useStore';
import type { SessionSummary } from '../types/bridge';
import {
  currentSessionLiveness,
  deliverQueuedPrompt,
  type QueueDeliverySnapshot,
  queuedSessionsThatSettled,
} from './promptQueueDelivery';

function session(
  appSessionId: string,
  phase: SessionSummary['phase'],
  streaming: boolean,
): SessionSummary {
  return {
    appSessionId,
    title: appSessionId,
    cwd: `/repo/${appSessionId}`,
    phase,
    streaming,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    autonomy: 'medium',
  };
}

test('a non-active Studio thread drains once when its own turn settles', () => {
  const previous = new Map([
    ['main-a', false],
    ['studio-b', true],
  ]);
  const sessions = {
    'main-a': session('main-a', 'running', true),
    'studio-b': session('studio-b', 'completed', true),
  };
  const queue = {
    'main-a': [{ id: 'main-queued' }],
    'studio-b': [{ id: 'studio-queued' }],
  };

  assert.deepEqual(queuedSessionsThatSettled(previous, sessions, queue), ['studio-b']);

  const next = currentSessionLiveness(sessions);
  assert.deepEqual(queuedSessionsThatSettled(next, sessions, queue), []);
});

test('settlement without a staged prompt does not create work', () => {
  const previous = new Map([['session-a', true]]);
  const sessions = { 'session-a': session('session-a', 'completed', false) };
  assert.deepEqual(queuedSessionsThatSettled(previous, sessions, {}), []);
});

test('delivery re-reads an edited queue head after the git baseline', async () => {
  let releaseBaseline: (() => void) | undefined;
  const baseline = new Promise<void>((resolve) => {
    releaseBaseline = resolve;
  });
  let snapshot = queueSnapshot(prompt('original', 'Original'));
  const sent: string[] = [];
  const removed: string[] = [];
  const transcripts: string[] = [];

  const delivery = deliverQueuedPrompt('studio-b', {
    snapshot: () => snapshot,
    markTurnStart: () => baseline,
    sendDesign: () => {
      throw new Error('unexpected design send');
    },
    sendSession: (_appSessionId, text) => {
      sent.push(text);
    },
    appendTranscript: (event) => {
      transcripts.push(event.text ?? '');
    },
    removePrompt: (_appSessionId, id) => {
      removed.push(id);
    },
    now: () => 42,
  });

  snapshot = queueSnapshot(prompt('edited', 'Edited'));
  releaseBaseline?.();

  assert.equal(await delivery, true);
  assert.deepEqual(sent, ['Edited']);
  assert.deepEqual(transcripts, ['Edited']);
  assert.deepEqual(removed, ['edited']);
});

test('a send failure retains the queued prompt', async () => {
  const removed: string[] = [];
  await assert.rejects(
    deliverQueuedPrompt('studio-b', {
      snapshot: () => queueSnapshot(prompt('queued', 'Keep me')),
      markTurnStart: async () => undefined,
      sendDesign: () => {
        throw new Error('unexpected design send');
      },
      sendSession: () => {
        throw new Error('bridge rejected send');
      },
      appendTranscript: () => {
        throw new Error('must not echo a rejected send');
      },
      removePrompt: (_appSessionId, id) => {
        removed.push(id);
      },
    }),
    /bridge rejected send/,
  );
  assert.deepEqual(removed, []);
});

function prompt(id: string, text: string): QueuedPrompt {
  return { id, text, skills: [], files: [] };
}

function queueSnapshot(head: QueuedPrompt): QueueDeliverySnapshot {
  return {
    sessions: { 'studio-b': session('studio-b', 'completed', false) },
    promptQueue: { 'studio-b': [head] },
  };
}
