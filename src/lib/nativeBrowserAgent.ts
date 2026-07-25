import type { BrowserNativeRequest, BrowserNativeResult } from '../types/bridge';
import { isDesktop } from './desktop';
import { performDesktopNativeBrowserRequest } from './nativeBrowser';

export interface NativeBrowserController {
  perform(request: BrowserNativeRequest): Promise<BrowserNativeResult>;
}

let controller: NativeBrowserController | null = null;
const waiters = new Set<() => void>();
const OPEN_CONTROLLER_GRACE_MS = 250;

export function registerNativeBrowserController(next: NativeBrowserController): () => void {
  controller = next;
  for (const notify of waiters) notify();
  waiters.clear();
  return () => {
    if (controller === next) controller = null;
  };
}

export async function performNativeBrowserRequest(
  request: BrowserNativeRequest,
  timeoutMs = 8_000,
): Promise<BrowserNativeResult> {
  if (!controller && isDesktop()) {
    if (request.action === 'open') {
      const mounted = await waitForController(Math.min(timeoutMs, OPEN_CONTROLLER_GRACE_MS)).catch(
        () => null,
      );
      if (mounted) return mounted.perform(request);
    }
    return performDesktopNativeBrowserRequest(request);
  }
  const active = controller ?? (await waitForController(timeoutMs));
  return active.perform(request);
}

function waitForController(timeoutMs: number): Promise<NativeBrowserController> {
  if (controller) return Promise.resolve(controller);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      waiters.delete(notify);
      reject(new Error('Droid Control browser pane is not ready.'));
    }, timeoutMs);
    const notify = () => {
      if (!controller) return;
      window.clearTimeout(timeout);
      waiters.delete(notify);
      resolve(controller);
    };
    waiters.add(notify);
  });
}
