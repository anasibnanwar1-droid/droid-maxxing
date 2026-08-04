import { isDesktop } from './desktop';
import type {
  AuditElement,
  BrowserBox,
  BrowserConsoleEvent,
  BrowserElementInspection,
  BrowserNetworkEvent,
  BrowserNativeAction,
  BrowserNativeRequest,
  BrowserNativeResult,
  BrowserNativeSnapshot,
  BrowserScrollDirection,
  DesignAnchor,
  DesignAnchorDetail,
  DesignSelectionScreenshot,
  DesignStrokePoint,
} from '../types/bridge';

export interface NativeBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type NativeBrowserBox = BrowserBox;

export interface NativeBrowserSelection {
  browserSessionId?: string;
  anchor: DesignAnchor;
  detail?: DesignAnchorDetail;
  url: string;
  title?: string;
  scroll?: { x: number; y: number };
  screenshot?: DesignSelectionScreenshot;
  strokes?: DesignStrokePoint[][];
}

export interface NativeBrowserLoaded {
  browserSessionId?: string;
  url: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface NativeBrowserLoadFailed {
  browserSessionId?: string;
  url: string;
  error?: string;
}

export interface NativeBrowserDesignPrompt {
  selection: NativeBrowserSelection;
  instruction: string;
}

export interface NativeBrowserAgentAction {
  requestId: string;
  browserSessionId: string;
  action: BrowserNativeAction;
  url?: string;
  x?: number;
  y?: number;
  selector?: string;
  text?: string;
  key?: string;
  direction?: BrowserScrollDirection;
  pixels?: number;
  viewport?: BrowserNativeRequest['viewport'];
  clearNetworkLog?: boolean;
  clearConsoleLog?: boolean;
}

export interface NativeBrowserAgentResult {
  requestId: string;
  ok: boolean;
  snapshot?: BrowserNativeSnapshot;
  inspection?: BrowserElementInspection;
  networkEvents?: BrowserNetworkEvent[];
  consoleEvents?: BrowserConsoleEvent[];
  audit?: AuditElement[];
  auditTruncated?: boolean;
  error?: string;
}

export function nativeBrowserAgentActionFromRequest(
  request: BrowserNativeRequest,
): NativeBrowserAgentAction {
  return {
    requestId: request.requestId,
    browserSessionId: request.browserSessionId,
    action: request.action,
    x: request.x,
    y: request.y,
    selector: request.selector,
    text: request.text,
    key: request.key,
    direction: request.direction,
    pixels: request.pixels,
    ...(request.viewport ? { viewport: request.viewport } : {}),
    ...(request.clearNetworkLog !== undefined ? { clearNetworkLog: request.clearNetworkLog } : {}),
    ...(request.clearConsoleLog !== undefined ? { clearConsoleLog: request.clearConsoleLog } : {}),
  };
}

export async function openNativeBrowser(
  browserSessionId: string,
  url: string,
  bounds?: NativeBrowserBounds,
  viewport?: { width: number; height: number; deviceScaleFactor: number },
  contentZoom?: number,
): Promise<void> {
  if (!isDesktop()) return;
  await desktopBridge().nativeBrowserOpen(
    browserSessionId,
    url,
    bounds ? normalizeBounds(bounds) : undefined,
    viewport,
    contentZoom,
  );
}

export async function attachNativeBrowser(
  browserSessionId: string,
  bounds: NativeBrowserBounds,
  url?: string,
  contentZoom?: number,
): Promise<void> {
  if (!isDesktop()) return;
  await desktopBridge().nativeBrowserAttach(
    browserSessionId,
    normalizeBounds(bounds),
    url,
    contentZoom,
  );
}

export async function detachNativeBrowser(browserSessionId?: string): Promise<void> {
  if (!isDesktop()) return;
  await desktopBridge().nativeBrowserDetach(browserSessionId);
}

export async function setNativeBrowserBounds(
  browserSessionId: string,
  bounds: NativeBrowserBounds,
  contentZoom?: number,
): Promise<void> {
  if (!isDesktop()) return;
  await desktopBridge().nativeBrowserSetBounds(
    browserSessionId,
    normalizeBounds(bounds),
    contentZoom,
  );
}

export async function setNativeBrowserVisible(
  browserSessionId: string,
  visible: boolean,
): Promise<void> {
  if (!isDesktop()) return;
  await desktopBridge().nativeBrowserSetVisible(browserSessionId, visible);
}

export async function closeNativeBrowser(browserSessionId: string): Promise<void> {
  if (!isDesktop()) return;
  await desktopBridge().nativeBrowserClose(browserSessionId);
}

export async function reloadNativeBrowser(browserSessionId: string): Promise<void> {
  if (!isDesktop()) return;
  await desktopBridge().nativeBrowserReload(browserSessionId);
}

export async function goBackNativeBrowser(browserSessionId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return desktopBridge().nativeBrowserGoBack(browserSessionId);
}

export async function goForwardNativeBrowser(browserSessionId: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return desktopBridge().nativeBrowserGoForward(browserSessionId);
}

export async function runNativeBrowserAgentAction(
  request: NativeBrowserAgentAction,
  timeoutMs = 10_000,
): Promise<NativeBrowserAgentResult> {
  if (!isDesktop())
    throw new Error('DroidMaxx native browser is only available in the desktop app.');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      unlisten();
      fn();
    };
    const timeout = window.setTimeout(() => {
      finish(() => {
        reject(new Error(`Droid Control browser action ${request.action} timed out.`));
      });
    }, timeoutMs);

    const unlisten = desktopBridge().onNativeBrowserAgentResult((result) => {
      if (result.requestId !== request.requestId) return;
      window.clearTimeout(timeout);
      finish(() => {
        resolve(result);
      });
    });
    desktopBridge()
      .nativeBrowserAgentAction(request)
      .then((result) => {
        if (result?.requestId !== request.requestId) return;
        window.clearTimeout(timeout);
        finish(() => {
          resolve(result);
        });
      })
      .catch((error: unknown) => {
        window.clearTimeout(timeout);
        finish(() => {
          reject(toError(error));
        });
      });
  });
}

export async function performDesktopNativeBrowserRequest(
  request: BrowserNativeRequest,
): Promise<BrowserNativeResult> {
  try {
    if (!isDesktop()) throw new Error('The native browser is only available in the desktop app.');
    if (request.action === 'close') {
      await closeNativeBrowser(request.browserSessionId);
      return nativeResult(request, true);
    }
    if (request.action === 'open') {
      const targetUrl = request.url ?? 'about:blank';
      await openNativeBrowser(request.browserSessionId, targetUrl, undefined, request.viewport);
      return nativeResult(request, true, await detachedSnapshot(request, targetUrl));
    }
    if (request.action === 'reload') {
      const loaded = waitForNextNativeBrowserLoad(request.browserSessionId).catch(() => undefined);
      await reloadNativeBrowser(request.browserSessionId);
      const event = await loaded;
      return nativeResult(request, true, await detachedSnapshot(request, event?.url));
    }
    if (request.action === 'goBack' || request.action === 'goForward') {
      const loaded = waitForNextNativeBrowserLoad(request.browserSessionId).catch(() => undefined);
      const moved =
        request.action === 'goBack'
          ? await goBackNativeBrowser(request.browserSessionId)
          : await goForwardNativeBrowser(request.browserSessionId);
      const event = moved ? await loaded : undefined;
      return nativeResult(request, true, await detachedSnapshot(request, event?.url));
    }
    if (request.action === 'capture') {
      const image = await nativeBrowserCapture(request.browserSessionId, request.box, {
        fullPage: request.fullPage,
        deviceScaleFactor: request.deviceScaleFactor,
      });
      return { ...nativeResult(request, true), image };
    }
    const result = await runNativeBrowserAgentAction(nativeBrowserAgentActionFromRequest(request));
    return nativeBrowserResultFromAgentResult(request, result);
  } catch (error) {
    return nativeResult(
      request,
      false,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function nativeBrowserResultFromAgentResult(
  request: BrowserNativeRequest,
  result: NativeBrowserAgentResult,
): BrowserNativeResult {
  return {
    ...nativeResult(request, result.ok),
    snapshot: result.snapshot,
    inspection: result.inspection,
    networkEvents: result.networkEvents,
    consoleEvents: result.consoleEvents,
    audit: result.audit,
    auditTruncated: result.auditTruncated,
    error: result.error,
  };
}

function nativeResult(
  request: BrowserNativeRequest,
  ok: boolean,
  snapshot?: BrowserNativeSnapshot,
  error?: string,
): BrowserNativeResult {
  return {
    requestId: request.requestId,
    appSessionId: request.appSessionId,
    browserSessionId: request.browserSessionId,
    ok,
    snapshot,
    error,
  };
}

async function detachedSnapshot(
  request: BrowserNativeRequest,
  fallbackUrl = 'about:blank',
): Promise<BrowserNativeSnapshot> {
  const result = await runNativeBrowserAgentAction({
    requestId: `${request.requestId}:snapshot`,
    browserSessionId: request.browserSessionId,
    action: 'snapshot',
  }).catch(() => undefined);
  return result?.ok && result.snapshot
    ? result.snapshot
    : { url: fallbackUrl, scroll: { x: 0, y: 0 }, refs: [] };
}

export interface NativeBrowserCaptureOptions {
  fullPage?: boolean;
  deviceScaleFactor?: number;
}

export async function nativeBrowserCapture(
  browserSessionId: string,
  box?: NativeBrowserBox,
  options?: NativeBrowserCaptureOptions,
): Promise<string | undefined> {
  if (!isDesktop()) return undefined;
  return desktopBridge().nativeBrowserCapture(browserSessionId, box, options);
}

export async function setNativeBrowserDesignMode(
  browserSessionId: string,
  active: boolean,
): Promise<void> {
  if (!isDesktop()) return;
  await desktopBridge().nativeBrowserSetDesignMode(browserSessionId, active);
}

export async function setNativeBrowserPencilMode(
  browserSessionId: string,
  active: boolean,
): Promise<void> {
  if (!isDesktop()) return;
  await desktopBridge().nativeBrowserSetPencilMode(browserSessionId, active);
}

export function onNativeBrowserSelection(
  handler: (selection: NativeBrowserSelection) => void,
): Promise<() => void> {
  if (!isDesktop()) return Promise.resolve(noop);
  return Promise.resolve(desktopBridge().onNativeBrowserSelection(handler));
}

export function onNativeBrowserDesignPrompt(
  handler: (prompt: NativeBrowserDesignPrompt) => void,
): Promise<() => void> {
  if (!isDesktop()) return Promise.resolve(noop);
  return Promise.resolve(desktopBridge().onNativeBrowserDesignPrompt(handler));
}

export function onNativeBrowserLoaded(
  handler: (event: NativeBrowserLoaded) => void,
): Promise<() => void> {
  if (!isDesktop()) return Promise.resolve(noop);
  return Promise.resolve(desktopBridge().onNativeBrowserLoaded(handler));
}

export function onNativeBrowserLoadFailed(
  handler: (event: NativeBrowserLoadFailed) => void,
): Promise<() => void> {
  if (!isDesktop()) return Promise.resolve(noop);
  return Promise.resolve(desktopBridge().onNativeBrowserLoadFailed(handler));
}

export function onNativeBrowserReset(handler: () => void): Promise<() => void> {
  if (!isDesktop()) return Promise.resolve(noop);
  return Promise.resolve(desktopBridge().onNativeBrowserReset(handler));
}

export async function waitForNextNativeBrowserLoad(
  browserSessionId: string,
  timeoutMs = 8_000,
): Promise<NativeBrowserLoaded> {
  if (!isDesktop())
    throw new Error('DroidMaxx native browser is only available in the desktop app.');
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
      finish(() => {
        reject(new Error('Droid Control browser page load timed out.'));
      });
    }, timeoutMs);
    void onNativeBrowserLoaded((event) => {
      if (event.browserSessionId !== browserSessionId) return;
      window.clearTimeout(timeout);
      finish(() => {
        resolve(event);
      });
    })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch((error: unknown) => {
        window.clearTimeout(timeout);
        finish(() => {
          reject(toError(error));
        });
      });
  });
}

function desktopBridge(): NonNullable<Window['droidControl']> {
  const bridge = window.droidControl;
  if (!bridge) throw new Error('The native browser desktop bridge is unavailable.');
  return bridge;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function noop(): void {
  return undefined;
}

function normalizeBounds(bounds: NativeBrowserBounds): NativeBrowserBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}
