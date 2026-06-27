import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissionLive } from './useMissionLive';
import type { MissionSummary } from '../types/bridge';
import type { WorkerInfo } from './useStore';

function mission(extra: Partial<MissionSummary> = {}): MissionSummary {
  const now = Date.now();
  return {
    id: 'm1',
    kind: 'chat',
    role: 'orchestrator',
    title: 'Test',
    goal: '',
    cwd: '',
    autonomy: 'medium',
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

test('compacting keeps a paused mission visibly live', () => {
  assert.equal(isMissionLive(mission({ phase: 'paused', compacting: true })), true);
});

test('approval waits are not live just because a stream flag is stale', () => {
  assert.equal(isMissionLive(mission({ phase: 'awaiting_plan_approval', streaming: true })), false);
});

test('running workers keep the parent mission visibly live', () => {
  const workers: WorkerInfo[] = [{ sessionId: 'w1', status: 'running', startedAt: Date.now() }];
  assert.equal(isMissionLive(mission({ phase: 'paused' }), workers), true);
});
