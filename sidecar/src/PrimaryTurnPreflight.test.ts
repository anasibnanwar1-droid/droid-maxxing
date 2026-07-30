import assert from 'node:assert/strict';
import test from 'node:test';
import {
  needsPrimaryTurnPreflightCompaction,
  PrimaryTurnPreflight,
} from './PrimaryTurnPreflight.js';
import type { SessionSummary } from './protocol.js';

function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    appSessionId: 'app-1',
    providerSessionId: 'provider-1',
    sessionPurpose: 'design',
    interactionMode: 'auto',
    role: 'primary',
    title: 'Design',
    goal: '',
    cwd: '/repo',
    workspaceKind: 'folder',
    autonomy: 'high',
    phase: 'paused',
    compacting: false,
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 1_000,
    contextRemainingTokens: 0,
    contextAccuracy: 'exact',
    maxContextTokens: 1_000,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

test('exact exhausted chat and design sessions require preflight compaction', () => {
  assert.equal(needsPrimaryTurnPreflightCompaction(summary()), true);
  assert.equal(
    needsPrimaryTurnPreflightCompaction(
      summary({
        sessionPurpose: 'chat',
        contextTokens: 900,
        contextRemainingTokens: 100,
        compactionTokenLimit: 900,
      }),
    ),
    true,
  );
});

test('estimated, empty, and Mission Control context never triggers the primary preflight', () => {
  assert.equal(
    needsPrimaryTurnPreflightCompaction(summary({ contextAccuracy: 'estimated' })),
    false,
  );
  assert.equal(needsPrimaryTurnPreflightCompaction(summary({ contextTokens: 0 })), false);
  assert.equal(
    needsPrimaryTurnPreflightCompaction(summary({ sessionPurpose: 'mission-control' })),
    false,
  );
});

test('a failed preflight blocks the redelivered prompt instead of compacting forever', () => {
  const preflight = new PrimaryTurnPreflight();
  const exhausted = summary();

  assert.equal(preflight.decide(exhausted), 'compact');
  assert.equal(preflight.decide(exhausted), 'blocked');
  assert.equal(
    preflight.decide(
      summary({
        contextTokens: 120,
        contextRemainingTokens: 880,
        contextAccuracy: 'exact',
      }),
    ),
    'ready',
  );
  assert.equal(preflight.decide(exhausted), 'compact');
});
