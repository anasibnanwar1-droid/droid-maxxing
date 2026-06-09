import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlMcpServer, SUBAGENT_MODEL_OVERRIDE_UNSUPPORTED } from './controlMcpServer.js';

test('control MCP rejects unsupported per-subagent model override', async () => {
  const server = createControlMcpServer({
    missionIdForTool: () => 'session-1',
  });

  assert.equal(server.name, 'droidmaxx-control');
  const nextModel = server.tools.find((tool) => tool.name === 'next_subagent_model');
  assert.ok(nextModel?.inputSchema?.modelId);
  assert.ok(nextModel?.inputSchema?.reasoningEffort);

  const result = await nextModel.handler({ modelId: 'gpt-5.4', reasoningEffort: 'xhigh' });
  assert.notEqual(typeof result, 'string');
  const structured = result as Exclude<typeof result, string>;
  assert.equal(structured.isError, true);
  const payload = JSON.parse(structured.content[0]?.type === 'text' ? structured.content[0].text : '{}') as { error?: string };
  assert.equal(payload.error, SUBAGENT_MODEL_OVERRIDE_UNSUPPORTED);
});
