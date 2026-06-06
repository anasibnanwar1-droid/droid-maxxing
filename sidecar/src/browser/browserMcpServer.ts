import { createSdkMcpServer, tool } from '@factory/droid-sdk';
import type { BrowserSessionManager } from './BrowserSessionManager.js';
import type { BrowserViewport, BrowserViewportMode, ScrollDirection } from './types.js';

export function createBrowserMcpServer(manager: BrowserSessionManager, missionIdForTool: () => string | undefined) {
  const missionId = () => {
    const id = missionIdForTool();
    if (!id) throw new Error('Browser tools are not attached to a live Droid Control mission yet.');
    return id;
  };

  return createSdkMcpServer({
    name: 'droid-control-browser',
    version: '0.1.0',
    tools: [
      tool('browser_open', 'Open a URL in the Droid Control browser canvas.', async (input) => {
        const state = await manager.open({
          missionId: missionId(),
          url: requiredString(input.url, 'url'),
          viewport: viewportValue(input.viewport),
          viewportMode: viewportModeValue(input.viewportMode),
        });
        return JSON.stringify(stateForTool(state), null, 2);
      }),
      tool('browser_snapshot', 'Return compact visible browser refs for the current page.', async () => {
        const state = await manager.refresh(missionId());
        return JSON.stringify(stateForTool(state), null, 2);
      }),
      tool('browser_screenshot', 'Capture the current browser viewport and return the local screenshot path.', async (input) => {
        const path = await manager.screenshot(missionId(), Boolean(input.fullPage));
        return path;
      }),
      tool('browser_click', 'Click a browser element by ref or viewport coordinates.', async (input) => {
        const state = await manager.click({
          missionId: missionId(),
          ref: optionalString(input.ref),
          x: optionalNumber(input.x),
          y: optionalNumber(input.y),
        });
        return JSON.stringify(stateForTool(state), null, 2);
      }),
      tool('browser_type', 'Type text into the focused browser element.', async (input) => {
        const state = await manager.type(missionId(), requiredString(input.text, 'text'));
        return JSON.stringify(stateForTool(state), null, 2);
      }),
      tool('browser_keypress', 'Press a key in the browser.', async (input) => {
        const state = await manager.keypress(missionId(), requiredString(input.key, 'key'));
        return JSON.stringify(stateForTool(state), null, 2);
      }),
      tool('browser_scroll', 'Scroll the current browser page.', async (input) => {
        const state = await manager.scroll(missionId(), scrollDirectionValue(input.direction), optionalNumber(input.pixels));
        return JSON.stringify(stateForTool(state), null, 2);
      }),
      tool('browser_design_context', 'Return the current browser Design Mode context.', () => {
        const state = manager.state(missionId());
        if (!state) throw new Error('Browser session is not open yet.');
        return JSON.stringify(stateForTool(state), null, 2);
      }),
    ],
  });
}

function stateForTool(state: ReturnType<BrowserSessionManager['state']> extends infer T ? NonNullable<T> : never): unknown {
  return {
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
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function viewportValue(value: unknown): BrowserViewport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const width = optionalNumber(item.width);
  const height = optionalNumber(item.height);
  const deviceScaleFactor = optionalNumber(item.deviceScaleFactor) ?? 1;
  if (!width || !height) return undefined;
  return { width, height, deviceScaleFactor };
}

function viewportModeValue(value: unknown): BrowserViewportMode | undefined {
  if (value === 'fit' || value === 'desktop' || value === 'laptop' || value === 'tablet' || value === 'mobile' || value === 'custom') return value;
  return undefined;
}

function scrollDirectionValue(value: unknown): ScrollDirection {
  if (value === 'up' || value === 'down' || value === 'left' || value === 'right') return value;
  throw new Error('direction must be up, down, left, or right');
}
