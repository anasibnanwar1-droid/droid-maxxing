import type { BrowserNativeRequest, BrowserNativeResult } from '../types/bridge';

export interface NativeBrowserController {
  perform(request: BrowserNativeRequest): Promise<BrowserNativeResult>;
}

let controller: NativeBrowserController | null = null;
const waiters = new Set<() => void>();

export function registerNativeBrowserController(next: NativeBrowserController): () => void {
  controller = next;
  for (const notify of waiters) notify();
  waiters.clear();
  return () => {
    if (controller === next) controller = null;
  };
}

export async function performNativeBrowserRequest(request: BrowserNativeRequest, timeoutMs = 8_000): Promise<BrowserNativeResult> {
  const active = controller ?? await waitForController(timeoutMs);
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
