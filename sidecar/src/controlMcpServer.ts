import { createSdkMcpServer, tool } from '@factory/droid-sdk';
import { z } from 'zod';
import { safeTool } from './mcpToolUtils.js';

const reasoningSchema = z.enum(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'dynamic']);
export const SUBAGENT_MODEL_OVERRIDE_UNSUPPORTED =
  'This Droid runtime does not support per-subagent model override yet. Parent session settings were not changed.';

export interface ControlMcpServerOptions {
  missionIdForTool: () => string | undefined;
}

export function createControlMcpServer(options: ControlMcpServerOptions) {
  const missionId = () => {
    const id = options.missionIdForTool();
    if (!id) throw new Error('Droid Control tools are not attached to a live session yet.');
    return id;
  };

  return createSdkMcpServer({
    name: 'droidmaxx-control',
    version: '0.1.0',
    tools: [
      tool(
        'next_subagent_model',
        [
          'Report that per-subagent model override is unavailable in this Droid runtime.',
          'Droid Control will not mutate the parent session model to fake a subagent-only override.',
          'Until Droid exposes a per-Task or per-custom-droid spawn override API, use the Task/default custom droid model.',
        ].join(' '),
        {
          modelId: z.string().min(1).optional().describe('Requested model id for the next subagent. Currently unsupported.'),
          reasoningEffort: reasoningSchema.optional().describe('Requested reasoning/thinking effort for the next subagent. Currently unsupported.'),
        },
        safeTool(async (input) => {
          missionId();
          if (!input.modelId && !input.reasoningEffort) {
            throw new Error('Provide modelId, reasoningEffort, or both.');
          }
          throw new Error(SUBAGENT_MODEL_OVERRIDE_UNSUPPORTED);
        }),
      ),
    ],
  });
}
