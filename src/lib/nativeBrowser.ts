import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';

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

function normalizeBounds(bounds: NativeBrowserBounds): NativeBrowserBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}
