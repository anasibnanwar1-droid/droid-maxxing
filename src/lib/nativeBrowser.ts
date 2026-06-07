import { isDesktop } from './desktop';
import type { BrowserNativeAction, BrowserNativeSnapshot, BrowserScrollDirection } from '../types/bridge';

export interface NativeBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeBrowserBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeBrowserSelection {
  sessionId?: string;
  id: string;
  kind: 'element' | 'region';
  url: string;
  title: string;
  selector?: string;
  tagName?: string;
  role?: string;
  name?: string;
  text?: string;
  box: NativeBrowserBox;
}

export interface NativeBrowserLoaded {
  sessionId?: string;
  url: string;
}

export interface NativeBrowserDesignPrompt {
  selection: NativeBrowserSelection;
  instruction: string;
}

export interface NativeBrowserAgentAction {
  requestId: string;
  sessionId: string;
  action: BrowserNativeAction;
  url?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  direction?: BrowserScrollDirection;
  pixels?: number;
}

export interface NativeBrowserAgentResult {
  requestId: string;
  ok: boolean;
  snapshot?: BrowserNativeSnapshot;
  error?: string;
}

export async function openNativeBrowser(
  sessionId: string,
  url: string,
  bounds?: NativeBrowserBounds,
  viewport?: { width: number; height: number; deviceScaleFactor: number },
): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserOpen(sessionId, url, bounds ? normalizeBounds(bounds) : undefined, viewport);
}

export async function attachNativeBrowser(sessionId: string, bounds: NativeBrowserBounds, url?: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserAttach(sessionId, normalizeBounds(bounds), url);
}

export async function detachNativeBrowser(sessionId?: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserDetach(sessionId);
}

export async function setNativeBrowserBounds(sessionId: string, bounds: NativeBrowserBounds): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserSetBounds(sessionId, normalizeBounds(bounds));
}

export async function closeNativeBrowser(sessionId: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserClose(sessionId);
}

export async function reloadNativeBrowser(sessionId: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserReload(sessionId);
}

export async function runNativeBrowserAgentAction(
  request: NativeBrowserAgentAction,
  timeoutMs = 10_000,
): Promise<NativeBrowserAgentResult> {
  if (!isDesktop()) throw new Error('DroidMaxx native browser is only available in the desktop app.');
  return new Promise((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      unlisten?.();
      fn();
    };
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error(`Droid Control browser action ${request.action} timed out.`)));
    }, timeoutMs);

    unlisten = window.droidControl!.onNativeBrowserAgentResult((result) => {
      if (result.requestId !== request.requestId) return;
      window.clearTimeout(timeout);
      finish(() => resolve(result));
    });
    window.droidControl!.nativeBrowserAgentAction(request)
      .then((result) => {
        if (!result || result.requestId !== request.requestId) return;
        window.clearTimeout(timeout);
        finish(() => resolve(result));
      })
      .catch((err) => {
        window.clearTimeout(timeout);
        finish(() => reject(err));
      });
  });
}

export async function setNativeBrowserDesignMode(sessionId: string, active: boolean): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserSetDesignMode(sessionId, active);
}

export async function setNativeBrowserSketchMode(sessionId: string, active: boolean): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.nativeBrowserSetSketchMode(sessionId, active);
}

export async function onNativeBrowserSelection(
  handler: (selection: NativeBrowserSelection) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return window.droidControl!.onNativeBrowserSelection(handler);
}

export async function onNativeBrowserDesignPrompt(
  handler: (prompt: NativeBrowserDesignPrompt) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return window.droidControl!.onNativeBrowserDesignPrompt(handler);
}

export async function onNativeBrowserLoaded(
  handler: (event: NativeBrowserLoaded) => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return window.droidControl!.onNativeBrowserLoaded(handler);
}

export async function waitForNextNativeBrowserLoad(sessionId: string, timeoutMs = 8_000): Promise<NativeBrowserLoaded> {
  if (!isDesktop()) throw new Error('DroidMaxx native browser is only available in the desktop app.');
  return new Promise((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      unlisten?.();
      fn();
    };
    const timeout = window.setTimeout(() => finish(() => reject(new Error('Droid Control browser page load timed out.'))), timeoutMs);
    void onNativeBrowserLoaded((event) => {
      if (event.sessionId !== sessionId) return;
      window.clearTimeout(timeout);
      finish(() => resolve(event));
    }).then((nextUnlisten) => {
      unlisten = nextUnlisten;
    }).catch((err) => {
      window.clearTimeout(timeout);
      finish(() => reject(err));
    });
  });
}

function normalizeBounds(bounds: NativeBrowserBounds): NativeBrowserBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}
