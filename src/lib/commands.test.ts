import assert from 'node:assert/strict';
import test from 'node:test';
import { bridge } from './bridge';
import { resumeMission, updateCompactionSettings } from './commands';
import type { ClientCommand } from '../types/bridge';

test('updateCompactionSettings preserves omitted and cleared global limits', () => {
  const sent: ClientCommand[] = [];
  const originalSend = bridge.send.bind(bridge);
  bridge.send = (cmd: ClientCommand) => {
    sent.push(cmd);
  };
  try {
    updateCompactionSettings({ compactionTokenLimitPerModel: { 'model-a': 100_000 } });
    updateCompactionSettings({ compactionTokenLimit: null, compactionTokenLimitPerModel: {} });
    updateCompactionSettings({ compactionTokenLimit: 200_000, compactionTokenLimitPerModel: {} });
    updateCompactionSettings({
      compactionTokenLimit: 'factory-default',
      compactionTokenLimitPerModel: {},
    });
  } finally {
    bridge.send = originalSend;
  }

  assert.deepEqual(sent, [
    {
      type: 'settings.compaction.update',
      compactionTokenLimitPerModel: { 'model-a': 100_000 },
    },
    {
      type: 'settings.compaction.update',
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: {},
    },
    {
      type: 'settings.compaction.update',
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: {},
    },
    {
      type: 'settings.compaction.update',
      compactionTokenLimit: 'factory-default',
      compactionTokenLimitPerModel: {},
    },
  ]);
});

test('resumeMission forwards current compaction settings', () => {
  const sent: ClientCommand[] = [];
  const originalSend = bridge.send.bind(bridge);
  bridge.send = (cmd: ClientCommand) => {
    sent.push(cmd);
  };
  try {
    resumeMission('session-1', {
      compactionTokenLimit: 100_000,
      compactionTokenLimitPerModel: { 'model-a': 80_000 },
    });
  } finally {
    bridge.send = originalSend;
  }

  assert.deepEqual(sent, [
    {
      type: 'mission.resume',
      sessionId: 'session-1',
      compactionTokenLimit: 100_000,
      compactionTokenLimitPerModel: { 'model-a': 80_000 },
    },
  ]);
});
