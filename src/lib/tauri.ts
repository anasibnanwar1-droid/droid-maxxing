import { invoke } from '@tauri-apps/api/core';

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function getBridgeInfo(): Promise<{ port: number; token: string }> {
  if (!isTauri()) return { port: 8765, token: '' };
  return invoke('bridge_info');
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke('pick_directory');
}

export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('notify', { title, body });
}

export async function getApiKey(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke('get_api_key');
}

export async function setApiKey(key: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_api_key', { key });
}

export async function clearApiKey(): Promise<void> {
  if (!isTauri()) return;
  await invoke('clear_api_key');
}

export async function listFiles(dir: string): Promise<string[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<string[]>('list_files', { dir });
  } catch {
    return [];
  }
}

export async function readFile(path: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>('read_file', { path });
  } catch {
    return null;
  }
}
