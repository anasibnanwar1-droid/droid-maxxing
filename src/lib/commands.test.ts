import assert from 'node:assert/strict';
import test from 'node:test';
import { bridge } from './bridge';
import { updateCompactionSettings } from './commands';
import type { ClientCommand } from '../types/bridge';

test('updateCompactionSettings sends null for a cleared global limit', () => {
  const sent: ClientCommand[] = [];
  const originalSend = bridge.send.bind(bridge);
  bridge.send = (cmd: ClientCommand) => {
    sent.push(cmd);
  };
  try {
    updateCompactionSettings({ compactionTokenLimitPerModel: { 'model-a': 100_000 } });
    updateCompactionSettings({ compactionTokenLimit: 200_000, compactionTokenLimitPerModel: {} });
  } finally {
    bridge.send = originalSend;
  }

  assert.deepEqual(sent, [
    {
      type: 'settings.compaction.update',
      compactionTokenLimit: null,
      compactionTokenLimitPerModel: { 'model-a': 100_000 },
    },
    {
      type: 'settings.compaction.update',
      compactionTokenLimit: 200_000,
      compactionTokenLimitPerModel: {},
    },
  ]);
});
