import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlMcpServer } from './controlMcpServer.js';

test('control MCP exposes next subagent model tool', async () => {
  const server = createControlMcpServer({
    missionIdForTool: () => 'session-1',
    async configureNextSubagentModel(missionId, settings) {
      assert.equal(missionId, 'session-1');
      assert.equal(settings.modelId, 'gpt-5.4');
      assert.equal(settings.reasoningEffort, 'xhigh');
      return settings;
    },
  });

  assert.equal(server.name, 'droidmaxx-control');
  const nextModel = server.tools.find((tool) => tool.name === 'next_subagent_model');
  assert.ok(nextModel?.inputSchema?.modelId);
  assert.ok(nextModel?.inputSchema?.reasoningEffort);

  const result = await nextModel.handler({ modelId: 'gpt-5.4', reasoningEffort: 'xhigh' });
  assert.match(String(result), /next inherited-model custom droid/);
});
