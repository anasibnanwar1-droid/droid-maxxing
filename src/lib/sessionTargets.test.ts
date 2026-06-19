import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactTargetSessionIdForMission,
  selectedAgentSessionIdForMission,
} from './sessionTargets';

test('selectedAgentSessionIdForMission only targets selected workers in plain chat/spec sessions', () => {
  assert.equal(selectedAgentSessionIdForMission({ kind: 'chat' }, 'worker-1'), 'worker-1');
  assert.equal(selectedAgentSessionIdForMission({ kind: 'spec' }, 'worker-1'), 'worker-1');
  assert.equal(
    selectedAgentSessionIdForMission({ kind: 'mission_orchestrator' }, 'worker-1'),
    null,
  );
  assert.equal(selectedAgentSessionIdForMission({ kind: 'chat' }, 'orchestrator'), null);
  assert.equal(selectedAgentSessionIdForMission({ kind: 'chat' }, null), null);
});

test('compactTargetSessionIdForMission compacts the selected worker before the orchestrator', () => {
  assert.equal(
    compactTargetSessionIdForMission({ id: 'chat-1', kind: 'chat' }, 'worker-1'),
    'worker-1',
  );
  assert.equal(
    compactTargetSessionIdForMission({ id: 'chat-1', kind: 'chat' }, 'orchestrator'),
    'chat-1',
  );
  assert.equal(
    compactTargetSessionIdForMission({ id: 'mission-1', kind: 'mission_orchestrator' }, 'worker-1'),
    'worker-1',
  );
  assert.equal(compactTargetSessionIdForMission(null, 'worker-1'), null);
});
