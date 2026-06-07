import type { NativeBrowserAgentAction, NativeBrowserAgentResult, NativeBrowserBounds, NativeBrowserLoaded, NativeBrowserSelection } from './nativeBrowser';

interface BridgeInfo {
  port: number;
  token: string;
}

interface DroidControlApi {
  bridgeInfo: () => Promise<BridgeInfo>;
  pickDirectory: () => Promise<string | null>;
  notify: (title: string, body: string) => Promise<void>;
  getApiKey: () => Promise<string | null>;
  setApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  listFiles: (dir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  nativeBrowserOpen: (url: string, bounds: NativeBrowserBounds) => Promise<void>;
  nativeBrowserSetBounds: (bounds: NativeBrowserBounds) => Promise<void>;
  nativeBrowserClose: () => Promise<void>;
  nativeBrowserReload: () => Promise<void>;
  nativeBrowserSetDesignMode: (active: boolean) => Promise<void>;
  nativeBrowserSetSketchMode: (active: boolean) => Promise<void>;
  nativeBrowserAgentAction: (request: NativeBrowserAgentAction) => Promise<void>;
  onNativeBrowserSelection: (handler: (selection: NativeBrowserSelection) => void) => () => void;
  onNativeBrowserLoaded: (handler: (event: NativeBrowserLoaded) => void) => () => void;
  onNativeBrowserAgentResult: (handler: (result: NativeBrowserAgentResult) => void) => () => void;
}

declare global {
  interface Window {
    droidControl?: DroidControlApi;
  }
}

export const isDesktop = () => typeof window !== 'undefined' && Boolean(window.droidControl);

export async function getBridgeInfo(): Promise<BridgeInfo> {
  if (!isDesktop()) return { port: 8765, token: '' };
  return window.droidControl!.bridgeInfo();
}

export async function pickDirectory(): Promise<string | null> {
  if (!isDesktop()) return null;
  return window.droidControl!.pickDirectory();
}

export async function notify(title: string, body: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.notify(title, body);
}

export async function getApiKey(): Promise<string | null> {
  if (!isDesktop()) return null;
  return window.droidControl!.getApiKey();
}

export async function setApiKey(key: string): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.setApiKey(key);
}

export async function clearApiKey(): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.clearApiKey();
}

export async function listFiles(dir: string): Promise<string[]> {
  if (!isDesktop()) return [];
  try {
    return await window.droidControl!.listFiles(dir);
  } catch {
    return [];
  }
}

export async function readFile(path: string): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    return await window.droidControl!.readFile(path);
  } catch {
    return null;
  }
}
