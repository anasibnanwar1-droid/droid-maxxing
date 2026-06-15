import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestPermissionRequestSchema } from '@factory/droid-sdk';
import { normalizeDroidTransportMessage } from './DroidTransport.js';

test('normalizes current CLI permission options before SDK validation', () => {
  const message = {
    jsonrpc: '2.0',
    factoryApiVersion: '1.0.0',
    type: 'request',
    id: 'permission-1',
    method: 'droid.request_permission',
    params: {
      toolUses: [
        {
          toolUse: {
            type: 'tool_use',
            id: 'tool-1',
            input: {},
            name: 'droidmaxx-browser___browser_open',
          },
          confirmationType: 'mcp_tool',
          details: {
            type: 'mcp_tool',
            toolName: 'droidmaxx-browser___browser_open',
            impactLevel: 'low',
          },
        },
      ],
      options: [
        { label: 'Allow once', value: 'proceed_once' },
        { label: 'Allow tool', value: 'proceed_always_tools' },
        { label: 'Allow server', value: 'proceed_always_server' },
        { label: 'Allow file', value: 'proceed_always_file' },
      ],
    },
  };

  const normalized = normalizeDroidTransportMessage(message);

  assert.deepEqual(
    (normalized.params as { options: { value: string }[] }).options.map((option) => option.value),
    ['proceed_once', 'proceed_always', 'proceed_always', 'proceed_always'],
  );
  assert.doesNotThrow(() => RequestPermissionRequestSchema.parse(normalized));
});

test('leaves non-permission messages untouched', () => {
  const message = {
    jsonrpc: '2.0',
    method: 'droid.session_notification',
    params: { text: 'proceed_always_tools' },
  };

  assert.equal(normalizeDroidTransportMessage(message), message);
});
