import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForLog } from './sensitiveLogRedaction';

test('sanitizeForLog redacts sensitive object fields', () => {
  assert.deepEqual(
    sanitizeForLog({
      type: 'bridge.connected',
      token: 'bridge-token',
      FACTORY_API_KEY: 'configured-placeholder',
      nested: {
        authorization: 'Bearer abc.def.ghi',
        message: 'ready',
      },
    }),
    {
      type: 'bridge.connected',
      token: '[REDACTED]',
      FACTORY_API_KEY: '[REDACTED]',
      nested: {
        authorization: '[REDACTED]',
        message: 'ready',
      },
    },
  );
});

test('sanitizeForLog redacts bearer tokens and secret assignments inside strings', () => {
  assert.equal(
    sanitizeForLog('Authorization: Bearer abc.def.ghi FACTORY_API_KEY=configured-placeholder'),
    'Authorization: Bearer [REDACTED] FACTORY_API_KEY=[REDACTED]',
  );
});

test('sanitizeForLog keeps cycles from leaking raw objects', () => {
  const event: Record<string, unknown> = { type: 'mission.progress' };
  event.self = event;

  assert.deepEqual(sanitizeForLog(event), {
    type: 'mission.progress',
    self: '[Circular]',
  });
});
