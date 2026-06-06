import { createSdkMcpServer, tool } from '@factory/droid-sdk';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { BrowserSessionManager } from './BrowserSessionManager.js';
import type { BrowserState, DesignReference } from './types.js';

const viewportSchema = z.object({
  width: z.number().int().min(240).max(4096),
  height: z.number().int().min(240).max(4096),
  deviceScaleFactor: z.number().positive().max(4).optional(),
});

const viewportModeSchema = z.enum(['fit', 'desktop', 'laptop', 'tablet', 'mobile', 'custom']);
const scrollDirectionSchema = z.enum(['up', 'down', 'left', 'right']);

export function createBrowserMcpServer(manager: BrowserSessionManager, missionIdForTool: () => string | undefined) {
  const missionId = () => {
    const id = missionIdForTool();
    if (!id) throw new Error('Browser tools are not attached to a live Droid Control mission yet.');
    return id;
  };

  return createSdkMcpServer({
    name: 'droidmaxx-browser',
    version: '0.1.0',
    tools: [
      tool(
        'browser_open',
        'Open a URL in the DroidMaxx browser canvas for this chat session.',
        {
          url: z.string().min(1).describe('Absolute URL to open, such as https://example.com or http://127.0.0.1:1421/.'),
          viewport: viewportSchema.optional().describe('Optional explicit browser viewport.'),
          viewportMode: viewportModeSchema.optional().describe('Viewport preset label for the UI.'),
        },
        safeTool(async (input) => {
          const state = await manager.open({
            missionId: missionId(),
            url: input.url,
            viewport: input.viewport ? { ...input.viewport, deviceScaleFactor: input.viewport.deviceScaleFactor ?? 2 } : undefined,
            viewportMode: input.viewportMode,
          });
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'browser_snapshot',
        'Return compact visible browser refs for the current page.',
        {},
        safeTool(async () => {
          const state = await manager.refresh(missionId());
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'browser_screenshot',
        'Capture the current browser viewport as a high-detail PNG image for visual inspection.',
        {
          fullPage: z.boolean().optional().describe('Capture the full page instead of only the visible viewport.'),
          deviceScaleFactor: z.number().positive().max(4).optional().describe('Temporary screenshot scale. Defaults to the current high-detail viewport scale.'),
        },
        safeTool(async (input) => {
          const path = await manager.screenshot(missionId(), {
            fullPage: input.fullPage ?? false,
            deviceScaleFactor: input.deviceScaleFactor,
          });
          return imageToolResult(path, { ok: true, screenshotPath: path, mimeType: 'image/png' });
        }),
      ),
      tool(
        'browser_click',
        'Click a browser element by ref or viewport coordinates.',
        {
          ref: z.string().optional().describe('Element ref returned by browser_snapshot. Preferred when available.'),
          x: z.number().optional().describe('Viewport x coordinate when clicking by coordinate.'),
          y: z.number().optional().describe('Viewport y coordinate when clicking by coordinate.'),
        },
        safeTool(async (input) => {
          const state = await manager.click({
            missionId: missionId(),
            ref: input.ref,
            x: input.x,
            y: input.y,
          });
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'browser_type',
        'Type text into the focused browser element.',
        {
          text: z.string().describe('Text to type into the currently focused browser element.'),
        },
        safeTool(async (input) => {
          const state = await manager.type(missionId(), input.text);
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'browser_keypress',
        'Press a key in the browser.',
        {
          key: z.string().min(1).describe('Key name to press, such as Enter, Escape, Tab, ArrowDown.'),
        },
        safeTool(async (input) => {
          const state = await manager.keypress(missionId(), input.key);
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'browser_scroll',
        'Scroll the current browser page.',
        {
          direction: scrollDirectionSchema.describe('Direction to scroll.'),
          pixels: z.number().positive().max(4000).optional().describe('Scroll amount in pixels.'),
        },
        safeTool(async (input) => {
          const state = await manager.scroll(missionId(), input.direction, input.pixels);
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'design_mode',
        'Read the current Design Mode browser context for the chat. Use after the user selects or sketches an area in the DroidMaxx browser canvas.',
        {
          instruction: z.string().optional().describe('Optional user design instruction to keep alongside the returned context.'),
        },
        safeTool(async (input) => {
          const context = manager.designContext(missionId());
          return jsonResult({
            ok: true,
            instruction: input.instruction,
            ...stateForTool(context.state, context.references),
          });
        }),
      ),
    ],
  });
}

function stateForTool(state: BrowserState, designReferences: DesignReference[] = []): Record<string, unknown> {
  return {
    ok: true,
    url: state.url,
    title: state.title,
    viewport: state.viewport,
    viewportMode: state.viewportMode,
    screenshotPath: state.screenshotPath,
    scroll: state.scroll,
    refs: state.refs.map((ref) => ({
      ref: ref.ref,
      role: ref.role,
      name: ref.name,
      text: ref.text,
      selector: ref.selector,
      box: ref.box,
    })),
    designReferences: designReferences.map((ref) => ({
      id: ref.id,
      kind: ref.kind,
      url: ref.url,
      title: ref.title,
      viewport: ref.viewport,
      screenshotPath: ref.screenshotPath,
      scroll: ref.scroll,
      element: ref.element
        ? {
            ref: ref.element.ref,
            role: ref.element.role,
            name: ref.element.name,
            text: ref.element.text,
            selector: ref.element.selector,
            box: ref.element.box,
          }
        : undefined,
      box: ref.box,
      points: ref.points,
      note: ref.note,
    })),
  };
}

type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolHandlerResult = string | { content: ToolContent[]; isError?: boolean };

function safeTool<T>(handler: (input: T) => Promise<ToolHandlerResult> | ToolHandlerResult): (input: T) => Promise<ToolHandlerResult> {
  return async (input: T) => {
    try {
      return await handler(input);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: jsonResult({ ok: false, error: errMsg(err) }) }],
      };
    }
  };
}

async function imageToolResult(path: string, metadata: unknown): Promise<ToolHandlerResult> {
  return {
    content: [
      { type: 'text', text: jsonResult(metadata) },
      { type: 'image', data: await readFile(path, 'base64'), mimeType: 'image/png' },
    ],
  };
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errMsg(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
