import test from 'node:test';
import assert from 'node:assert';
import { activeSessionCwds, missionIsLive } from './missions';
import type { MissionSummary } from '../types/bridge';

function mission(over: Partial<MissionSummary>): MissionSummary {
  return { id: 'm', cwd: '', phase: 'completed', ...over } as MissionSummary;
}

test('missionIsLive treats terminal/awaiting phases as not live', () => {
  assert.equal(missionIsLive({ phase: 'completed' }), false);
  assert.equal(missionIsLive({ phase: 'paused' }), false);
  assert.equal(missionIsLive({ phase: 'awaiting_plan_approval' }), false);
  // streaming wins over a non-terminal, not-clearly-active phase
  assert.equal(missionIsLive({ phase: 'running', streaming: true }), true);
  // a completed mission is never live even while a stale streaming flag lingers
  assert.equal(missionIsLive({ phase: 'completed', streaming: true }), false);
  assert.equal(missionIsLive({ phase: 'orchestrator_turn' }), true);
});

test('activeSessionCwds includes the draft, the active chat, and live missions only', () => {
  const missions = [
    mission({ id: 'active', cwd: '/repo/a', phase: 'completed' }),
    mission({ id: 'live', cwd: '/repo/b', phase: 'orchestrator_turn' }),
    mission({ id: 'idle', cwd: '/repo/c', phase: 'completed' }),
    mission({ id: 'nocwd', cwd: '', phase: 'orchestrator_turn' }),
  ];
  const cwds = activeSessionCwds({
    missions,
    activeMissionId: 'active',
    draftCwd: '/repo/draft',
  });
  assert.deepEqual(cwds.sort(), ['/repo/a', '/repo/b', '/repo/draft']);
  // an idle historical chat does not pin its worktree
  assert.equal(cwds.includes('/repo/c'), false);
});

test('activeSessionCwds pins an idle mission that still has a running worker', () => {
  const missions = [
    mission({ id: 'idle', cwd: '/repo/idle', phase: 'completed' }),
    mission({ id: 'done', cwd: '/repo/done', phase: 'completed' }),
  ];
  const cwds = activeSessionCwds({
    missions,
    activeMissionId: null,
    workers: {
      idle: [{ status: 'completed' }, { status: 'running' }],
      done: [{ status: 'completed' }, { status: 'paused' }],
    },
  });
  // the worker is still running in the idle mission's cwd, so it must stay pinned
  assert.equal(cwds.includes('/repo/idle'), true);
  // no running worker (only completed/paused) leaves the worktree removable
  assert.equal(cwds.includes('/repo/done'), false);
});
