import { createSdkMcpServer, tool } from '@factory/droid-sdk';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { BrowserSessionManager } from './BrowserSessionManager.js';
import type { BrowserState, DesignReference } from './types.js';
import { jsonResult, safeTool, type ToolHandlerResult } from '../mcpToolUtils.js';

const viewportSchema = z.object({
  width: z.number().int().min(240).max(4096),
  height: z.number().int().min(240).max(4096),
  deviceScaleFactor: z.number().positive().max(4).optional(),
});

const viewportModeSchema = z.enum(['fit', 'desktop', 'laptop', 'tablet', 'mobile', 'custom']);
const scrollDirectionSchema = z.enum(['up', 'down', 'left', 'right']);

export function createBrowserMcpServer(
  manager: BrowserSessionManager,
  missionIdForTool: () => string | undefined,
) {
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
        [
          'Open and show a URL in the live Droid Control browser pane for this chat session.',
          'This is the browser the user can see and control in Droid Control.',
          'When the user asks to open a site, navigate, click, inspect, or control a browser, call this tool first with the site URL.',
          'If the user names a domain without a scheme, pass it directly; Droid Control will load it as https.',
          'Do not ask the user for a URL when they already named a site or domain.',
          'Do not use Read, FetchUrl, curl, or agent-browser as a substitute for browser work.',
        ].join(' '),
        {
          url: z
            .string()
            .min(1)
            .describe(
              'Absolute URL to open, such as https://example.com or http://127.0.0.1:1421/.',
            ),
          viewport: viewportSchema.optional().describe('Optional explicit browser viewport.'),
          viewportMode: viewportModeSchema.optional().describe('Viewport preset label for the UI.'),
        },
        safeTool(async (input) => {
          const state = await manager.open({
            missionId: missionId(),
            url: input.url,
            viewport: input.viewport
              ? { ...input.viewport, deviceScaleFactor: input.viewport.deviceScaleFactor ?? 2 }
              : undefined,
            viewportMode: input.viewportMode ?? (input.viewport ? 'custom' : undefined),
          });
          return jsonResult({
            message:
              'Opened the live Droid Control browser. Use browser_snapshot next for refs, then browser_click/browser_type/browser_scroll for interaction.',
            ...stateForTool(state),
          });
        }),
      ),
      tool(
        'browser_snapshot',
        'Return compact DOM refs and visible page state from the live Droid Control browser. Use this after browser_open and after each navigation or interaction.',
        {},
        safeTool(async () => {
          const state = await manager.refresh(missionId());
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'browser_reload',
        'Reload the current live Droid Control browser page. Use browser_snapshot after reload when fresh refs are needed.',
        {},
        safeTool(async () => {
          const state = await manager.reload(missionId());
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'browser_screenshot',
        'Capture the current live Droid Control browser viewport as a high-detail PNG image for visual inspection. Use browser_snapshot for normal navigation refs.',
        {
          fullPage: z
            .boolean()
            .optional()
            .describe('Capture the full page instead of only the visible viewport.'),
          deviceScaleFactor: z
            .number()
            .positive()
            .max(4)
            .optional()
            .describe(
              'Temporary screenshot scale. Defaults to the current high-detail viewport scale.',
            ),
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
        'Move the agent cursor and click in the live Droid Control browser by ref or viewport coordinates. Prefer refs returned by browser_snapshot.',
        {
          ref: z
            .string()
            .optional()
            .describe('Element ref returned by browser_snapshot. Preferred when available.'),
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
        'Type text into the currently focused element in the live Droid Control browser. Click or focus an input first.',
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
        'Press a key in the live Droid Control browser.',
        {
          key: z
            .string()
            .min(1)
            .describe('Key name to press, such as Enter, Escape, Tab, ArrowDown.'),
        },
        safeTool(async (input) => {
          const state = await manager.keypress(missionId(), input.key);
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'browser_resize',
        'Resize the viewport of the live Droid Control browser. Use this to check responsive layouts or to match a specific screen size.',
        {
          viewport: viewportSchema.describe('New viewport dimensions.'),
          viewportMode: viewportModeSchema.optional().describe('Viewport preset label.'),
        },
        safeTool(async (input) => {
          const state = await manager.resizeViewport({
            missionId: missionId(),
            viewport: {
              ...input.viewport,
              deviceScaleFactor: input.viewport.deviceScaleFactor ?? 2,
            },
            viewportMode: input.viewportMode ?? 'custom',
          });
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'browser_scroll',
        'Scroll the live Droid Control browser page, then call browser_snapshot to refresh refs.',
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
        'browser_fill_login',
        [
          'Fill the saved login for the current site in the live Droid Control browser.',
          'You never see the username or password: the values are injected securely in the app and are redacted from every snapshot. This lets you authorize a sign-in without reading the secret.',
          'Saved logins are strictly opt-in. Use only when a sign-in form is visible and the user has previously enabled saved logins and saved a credential for this site.',
          'Returns an error if saved logins are disabled or no credential is saved; in that case ask the user to sign in once and accept the save-login prompt. After filling, you may submit the form with browser_click or browser_keypress.',
        ].join(' '),
        {},
        safeTool(async () => {
          const state = await manager.fillCredentials(missionId());
          return jsonResult(stateForTool(state));
        }),
      ),
      tool(
        'design-mode',
        [
          'Read the current Design Mode browser context for this chat only.',
          'Use after the user selects, clicks, or sketches an area in the live Droid Control browser pane.',
          'Returns compact source-anchored references: each has an @id, label, kind, tag/role/name/text, box, resolved source (framework/component/file), a verified CSS selector, and a cropped screenshotPath.',
          'When you need the full element detail (all attributes, computed styles, ancestor chain, outerHTML), call design_reference with the @id instead of asking the user.',
          'Design Mode is for visual/UI work only: change the referenced elements and their styling, and do not modify backend, data, or business logic. If achieving the requested look requires a backend or data change, stop and tell the user what is needed and why instead of changing it yourself or spawning subagents.',
        ].join(' '),
        {
          instruction: z
            .string()
            .optional()
            .describe('Optional user design instruction to keep alongside the returned context.'),
        },
        safeTool(async (input) => {
          const context = manager.designContext(missionId());
          const refs = context.references;
          const images = refs
            .filter((r) => r.screenshot)
            .map((r) => ({
              type: 'image' as const,
              data: r.screenshot!.base64,
              mimeType: 'image/png' as const,
            }));
          const result = jsonResult({
            ok: true,
            instruction: input.instruction,
            ...stateForTool(context.state, refs),
          });
          if (images.length > 0) {
            return { content: [{ type: 'text' as const, text: result }, ...images] };
          }
          return result;
        }),
      ),
      tool(
        'design_reference',
        [
          'Fetch the full source-anchored detail for one Design Mode reference by its @id.',
          'Use the @id values returned by design-mode to inspect the exact verified selector, attributes, computed styles, ancestor chain, resolved source component/file, and the cropped screenshot path before editing code.',
        ].join(' '),
        {
          id: z
            .string()
            .min(1)
            .describe(
              'Design reference id returned by design-mode, e.g. @live-ab12cd or @region-...',
            ),
        },
        safeTool(async (input) => {
          const ref = manager.referenceDetail(missionId(), input.id);
          if (!ref) {
            return jsonResult({
              ok: false,
              error: `No design reference ${input.id}. Call design-mode to list the current references.`,
            });
          }
          const text = jsonResult({ ok: true, reference: designReferenceDetail(ref) });
          if (ref.screenshot?.base64) {
            return {
              content: [
                { type: 'text' as const, text },
                {
                  type: 'image' as const,
                  data: ref.screenshot.base64,
                  mimeType: 'image/png' as const,
                },
              ],
            };
          }
          return text;
        }),
      ),
    ],
  });
}

function stateForTool(
  state: BrowserState,
  designReferences: DesignReference[] = [],
): Record<string, unknown> {
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
    designReferences: designReferences.map(designReferenceSummary),
  };
}

function designReferenceSummary(ref: DesignReference): Record<string, unknown> {
  const anchor = ref.anchor;
  const out: Record<string, unknown> = {
    id: ref.id,
    kind: anchor.kind,
    label: anchor.label,
    tag: anchor.tag,
    role: anchor.role,
    name: anchor.name,
    text: anchor.text,
    box: anchor.box,
    source: anchor.source,
    selector: ref.detail?.selector,
    selectorVerified: ref.detail?.selectorVerified,
    screenshotPath: anchor.screenshotPath,
    url: ref.url,
  };
  if (anchor.strokes) out.strokes = anchor.strokes;
  // The annotated screenshot bytes are returned as a separate image block by
  // the design-mode / design_reference tools; keep them out of the JSON to
  // avoid duplicating large base64 payloads.
  if (ref.screenshot) out.hasScreenshot = true;
  return out;
}

function designReferenceDetail(ref: DesignReference): Record<string, unknown> {
  return {
    ...designReferenceSummary(ref),
    title: ref.title,
    viewport: ref.viewport,
    scroll: ref.scroll,
    createdAt: ref.createdAt,
    detail: ref.detail
      ? {
          selector: ref.detail.selector,
          selectorVerified: ref.detail.selectorVerified,
          attributes: ref.detail.attributes,
          styles: ref.detail.styles,
          ancestors: ref.detail.ancestors,
          html: ref.detail.html,
        }
      : undefined,
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
