import { createSdkMcpServer, tool } from '@factory/droid-sdk';
import { z } from 'zod';
import type { ReasoningEffort } from './protocol.js';
import { jsonResult, safeTool } from './mcpToolUtils.js';

const reasoningSchema = z.enum(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'dynamic']);

export interface ControlMcpServerOptions {
  missionIdForTool: () => string | undefined;
  configureNextSubagentModel: (
    missionId: string,
    settings: { modelId?: string; reasoningEffort?: ReasoningEffort },
  ) => Promise<{ modelId?: string; reasoningEffort?: ReasoningEffort }>;
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
          'Set the model and reasoning effort for the next Task-spawned custom droid in this session.',
          'Use this immediately before the Task tool when the user asks for a specific model or thinking level.',
          'It affects droids whose frontmatter uses model: inherit. Droids with a fixed model keep their fixed Factory behavior.',
          'After the next subagent starts, Droid Control restores the parent session model.',
        ].join(' '),
        {
          modelId: z.string().min(1).optional().describe('Exact model id for the next inherited-model custom droid.'),
          reasoningEffort: reasoningSchema.optional().describe('Reasoning/thinking effort for the next inherited-model custom droid.'),
        },
        safeTool(async (input) => {
          if (!input.modelId && !input.reasoningEffort) {
            throw new Error('Provide modelId, reasoningEffort, or both.');
          }
          const settings = await options.configureNextSubagentModel(missionId(), {
            modelId: input.modelId,
            reasoningEffort: input.reasoningEffort,
          });
          return jsonResult({
            ok: true,
            ...settings,
            message: 'The next inherited-model custom droid will use this model override.',
          });
        }),
      ),
    ],
  });
}
