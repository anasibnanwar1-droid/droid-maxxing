import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';
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
  url: string;
}

export interface NativeBrowserAgentAction {
  requestId: string;
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

export async function openNativeBrowser(url: string, bounds: NativeBrowserBounds): Promise<void> {
  if (!isTauri()) return;
  await invoke('native_browser_open', { url, bounds: normalizeBounds(bounds) });
}

export async function setNativeBrowserBounds(bounds: NativeBrowserBounds): Promise<void> {
  if (!isTauri()) return;
  await invoke('native_browser_set_bounds', { bounds: normalizeBounds(bounds) });
}

export async function closeNativeBrowser(): Promise<void> {
  if (!isTauri()) return;
  await invoke('native_browser_close');
}

export async function reloadNativeBrowser(): Promise<void> {
  if (!isTauri()) return;
  await invoke('native_browser_reload');
}

export async function runNativeBrowserAgentAction(
  request: NativeBrowserAgentAction,
  timeoutMs = 10_000,
): Promise<NativeBrowserAgentResult> {
  if (!isTauri()) throw new Error('DroidMaxx native browser is only available in the macOS app.');
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
      finish(() => reject(new Error(`DroidMaxx browser action ${request.action} timed out.`)));
    }, timeoutMs);

    void listen<NativeBrowserAgentResult>('native-browser-agent-result', (event) => {
      if (event.payload.requestId !== request.requestId) return;
      window.clearTimeout(timeout);
      finish(() => resolve(event.payload));
    }).then((nextUnlisten) => {
      unlisten = nextUnlisten;
      return invoke('native_browser_agent_action', { request });
    }).catch((err) => {
      window.clearTimeout(timeout);
      finish(() => reject(err));
    });
  });
}

export async function setNativeBrowserDesignMode(active: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke('native_browser_set_design_mode', { active });
}

export async function setNativeBrowserSketchMode(active: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke('native_browser_set_sketch_mode', { active });
}

export async function onNativeBrowserSelection(
  handler: (selection: NativeBrowserSelection) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<NativeBrowserSelection>('native-browser-selection', (event) => handler(event.payload));
}

export async function onNativeBrowserLoaded(
  handler: (event: NativeBrowserLoaded) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<NativeBrowserLoaded>('native-browser-loaded', (event) => handler(event.payload));
}

export async function waitForNextNativeBrowserLoad(timeoutMs = 8_000): Promise<NativeBrowserLoaded> {
  if (!isTauri()) throw new Error('DroidMaxx native browser is only available in the macOS app.');
  return new Promise((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      unlisten?.();
      fn();
    };
    const timeout = window.setTimeout(() => finish(() => reject(new Error('DroidMaxx browser page load timed out.'))), timeoutMs);
    void onNativeBrowserLoaded((event) => {
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
