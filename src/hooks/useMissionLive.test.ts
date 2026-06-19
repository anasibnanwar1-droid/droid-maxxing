import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissionLive } from './useMissionLive';
import type { MissionPhase } from '../types/bridge';

function live(phase: MissionPhase, streaming: boolean): boolean {
  return isMissionLive({ phase, streaming });
}

test('approval waiting phases are not live even while the stream is open', () => {
  assert.equal(live('awaiting_plan_approval', true), false);
  assert.equal(live('awaiting_run_start', true), false);
});

test('stale paused phase does not hide an active stream', () => {
  assert.equal(live('paused', true), true);
});

test('active phases are live before streaming arrives', () => {
  assert.equal(live('planning', false), true);
  assert.equal(live('initializing', false), true);
});
