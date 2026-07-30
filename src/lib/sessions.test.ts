import test from 'node:test';
import assert from 'node:assert';
import { activeSessionCwds, sessionIsLive } from './sessions';
import type { SessionSummary } from '../types/bridge';

function session(over: Partial<SessionSummary>): SessionSummary {
  return { appSessionId: 'session', cwd: '', phase: 'completed', ...over } as SessionSummary;
}

test('sessionIsLive treats terminal and awaiting phases as not live', () => {
  assert.equal(sessionIsLive({ phase: 'completed' }), false);
  assert.equal(sessionIsLive({ phase: 'paused' }), false);
  assert.equal(sessionIsLive({ phase: 'awaiting_plan_approval' }), false);
  // streaming wins over a non-terminal, not-clearly-active phase
  assert.equal(sessionIsLive({ phase: 'running', streaming: true }), true);
  assert.equal(sessionIsLive({ phase: 'running', streaming: false }), false);
  // a completed session is never live even while a stale streaming flag lingers
  assert.equal(sessionIsLive({ phase: 'completed', streaming: true }), false);
  assert.equal(sessionIsLive({ phase: 'orchestrator_turn' }), true);
});

test('activeSessionCwds includes the draft, active chat, and live sessions only', () => {
  const sessions = [
    session({ appSessionId: 'active', cwd: '/repo/a', phase: 'completed' }),
    session({ appSessionId: 'live', cwd: '/repo/b', phase: 'orchestrator_turn' }),
    session({ appSessionId: 'idle', cwd: '/repo/c', phase: 'completed' }),
    session({ appSessionId: 'nocwd', cwd: '', phase: 'orchestrator_turn' }),
  ];
  const cwds = activeSessionCwds({
    sessions,
    activeAppSessionId: 'active',
    draftCwd: '/repo/draft',
  });
  assert.deepEqual(cwds.sort(), ['/repo/a', '/repo/b', '/repo/draft']);
  // an idle historical chat does not pin its worktree
  assert.equal(cwds.includes('/repo/c'), false);
});

test('activeSessionCwds pins an idle session that still has a running worker', () => {
  const sessions = [
    session({ appSessionId: 'idle', cwd: '/repo/idle', phase: 'completed' }),
    session({ appSessionId: 'done', cwd: '/repo/done', phase: 'completed' }),
  ];
  const cwds = activeSessionCwds({
    sessions,
    activeAppSessionId: null,
    childSessions: {
      idle: [{ status: 'completed' }, { status: 'running' }],
      done: [{ status: 'completed' }, { status: 'paused' }],
    },
    childRuntime: {
      idle: {
        1: { available: true },
      },
    },
  });
  // the worker is still running in the idle session's cwd, so it must stay pinned
  assert.equal(cwds.includes('/repo/idle'), true);
  // no running worker (only completed/paused) leaves the worktree removable
  assert.equal(cwds.includes('/repo/done'), false);
});

test('activeSessionCwds ignores historical running status without a live child runtime', () => {
  const cwds = activeSessionCwds({
    sessions: [session({ appSessionId: 'closed', cwd: '/repo/closed', phase: 'completed' })],
    activeAppSessionId: null,
    childSessions: {
      closed: {
        child: { status: 'running' },
      },
    },
  });

  assert.deepEqual(cwds, []);
});

test('activeSessionCwds includes directories pinned by embedded terminals', () => {
  const cwds = activeSessionCwds({
    sessions: [],
    activeAppSessionId: null,
    pinnedCwds: ['/repo/terminal'],
  });
  assert.deepEqual(cwds, ['/repo/terminal']);
});
