import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { isDesktop } from '../../lib/desktop';
import {
  attachIframeDesignMode,
  clickIframe,
  keypressIframe,
  scrollIframe,
  snapshotIframe,
  typeIntoIframe,
} from '../../lib/iframeDesignMode';
import {
  attachNativeBrowser,
  closeNativeBrowser,
  detachNativeBrowser,
  onNativeBrowserDesignPrompt,
  onNativeBrowserLoadFailed,
  onNativeBrowserLoaded,
  onNativeBrowserSelection,
  openNativeBrowser,
  nativeBrowserCapture,
  runNativeBrowserAgentAction,
  setNativeBrowserBounds,
  setNativeBrowserDesignMode,
  setNativeBrowserPencilMode,
  waitForNextNativeBrowserLoad,
  type NativeBrowserBounds,
  type NativeBrowserDesignPrompt,
  type NativeBrowserLoadFailed,
  type NativeBrowserSelection,
  reloadNativeBrowser,
} from '../../lib/nativeBrowser';
import { registerNativeBrowserController } from '../../lib/nativeBrowserAgent';
import { nativeBrowserRequestTargetsVisibleSurface } from '../../lib/browserSessionIdentity';
import type { BrowserNativeRequest, BrowserNativeResult, BrowserViewport, BrowserViewportMode } from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';
import { useElementSize } from './useElementSize';

interface NativeBrowserSurfaceProps {
  browserKey: string;
  visibleSessionId?: string;
  obscured?: boolean;
  url: string;
  viewport: BrowserViewport;
  viewportMode: BrowserViewportMode;
  designMode: boolean;
  pencilMode: boolean;
  onLoaded: (url: string) => void;
  onSelection: (selection: NativeBrowserSelection) => void;
  onPrompt: (prompt: NativeBrowserDesignPrompt) => void;
  onLoadFailed?: (failure: NativeBrowserLoadFailed) => void;
  onViewportSizeChange: (size: Size) => void;
}

export function NativeBrowserSurface({
  browserKey,
  visibleSessionId,
  obscured = false,
  url,
  viewport,
  viewportMode,
  designMode,
  pencilMode,
  onLoaded,
  onSelection,
  onPrompt,
  onLoadFailed,
  onViewportSizeChange,
}: NativeBrowserSurfaceProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const frameSize = useElementSize(stageRef);
  const surfaceReady = frameSize.width > 8 && frameSize.height > 8;
  const lastBounds = useRef<NativeBrowserBounds | null>(null);
  const attachedSessionRef = useRef<string | undefined>(undefined);
  const attachingSessionRef = useRef<string | undefined>(undefined);
  const onLoadedRef = useRef(onLoaded);
  const onSelectionRef = useRef(onSelection);
  const onPromptRef = useRef(onPrompt);
  const onLoadFailedRef = useRef(onLoadFailed);
  const native = isDesktop();
  const surface = useMemo(
    () => surfaceLayout(frameSize, viewport, viewportMode),
    [frameSize, viewport, viewportMode],
  );

  useEffect(() => {
    onLoadedRef.current = onLoaded;
    onSelectionRef.current = onSelection;
    onPromptRef.current = onPrompt;
    onLoadFailedRef.current = onLoadFailed;
  }, [onLoadFailed, onLoaded, onPrompt, onSelection]);

  useEffect(() => {
    onViewportSizeChange({ width: Math.round(surface.width), height: Math.round(surface.height) });
  }, [onViewportSizeChange, surface.height, surface.width]);

  useEffect(() => {
    if (visibleSessionId) setNativeBrowserDesignMode(visibleSessionId, designMode).catch(() => {});
  }, [designMode, visibleSessionId]);

  useEffect(() => {
    if (visibleSessionId) setNativeBrowserPencilMode(visibleSessionId, designMode && pencilMode).catch(() => {});
  }, [designMode, pencilMode, visibleSessionId]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const track = (promise: Promise<() => void>) => {
      void promise.then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      });
    };

    track(onNativeBrowserSelection((selection) => {
      if (selection.sessionId && selection.sessionId !== visibleSessionId) return;
      onSelectionRef.current(selection);
    }));
    track(onNativeBrowserDesignPrompt((prompt) => {
      if (prompt.selection.sessionId && prompt.selection.sessionId !== visibleSessionId) return;
      onPromptRef.current(prompt);
    }));
    track(onNativeBrowserLoaded((event) => {
      if (event.sessionId && event.sessionId !== visibleSessionId) return;
      onLoadedRef.current(event.url);
    }));
    track(onNativeBrowserLoadFailed((failure) => {
      if (failure.sessionId && failure.sessionId !== visibleSessionId) return;
      onLoadFailedRef.current?.(failure);
    }));

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [visibleSessionId]);

  useEffect(() => {
    if (native) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    let detachDesignMode = () => {};
    const attach = () => {
      detachDesignMode();
      try {
        detachDesignMode = attachIframeDesignMode(iframe, {
          designMode,
          pencilMode,
          onSelection,
        });
        onLoaded(readIframeUrl(iframe) ?? url);
      } catch {
        detachDesignMode = () => {};
      }
    };
    attach();
    iframe.addEventListener('load', attach);
    return () => {
      iframe.removeEventListener('load', attach);
      detachDesignMode();
    };
  }, [designMode, native, onLoaded, onSelection, pencilMode, url]);

  useEffect(() => {
    if (!native) return;
    if (obscured) {
      detachNativeBrowser(visibleSessionId).catch(() => {});
      attachedSessionRef.current = undefined;
      attachingSessionRef.current = undefined;
      lastBounds.current = null;
      return;
    }
    if (!surfaceReady) return;
    const bounds = boundsFor(slotRef);
    if (!bounds) return;
    if (!visibleSessionId) {
      detachNativeBrowser().catch(() => {});
      attachedSessionRef.current = undefined;
      attachingSessionRef.current = undefined;
      lastBounds.current = null;
      return;
    }
    if (attachedSessionRef.current !== visibleSessionId) {
      // Avoid duplicate attaches while one is in flight, and only mark the
      // session attached once attachNativeBrowser actually resolves so a failed
      // attach can be retried by a later effect run.
      if (attachingSessionRef.current === visibleSessionId) return;
      const target = visibleSessionId;
      attachingSessionRef.current = target;
      attachNativeBrowser(target, bounds, url)
        .then(() => {
          // A newer session may have started attaching while this was in
          // flight; only commit state if `target` is still the intended one.
          if (attachingSessionRef.current !== target) return;
          attachedSessionRef.current = target;
          lastBounds.current = bounds;
        })
        .catch(() => {})
        .finally(() => {
          if (attachingSessionRef.current === target) attachingSessionRef.current = undefined;
        });
      return;
    }
    if (!lastBounds.current || !equalBounds(lastBounds.current, bounds)) {
      setNativeBrowserBounds(visibleSessionId, bounds).catch(() => {});
      lastBounds.current = bounds;
    }
  }, [native, obscured, surface.height, surface.left, surface.top, surface.width, surfaceReady, url, visibleSessionId]);

  useEffect(() => registerNativeBrowserController({
    perform: async (request) => native
      ? performNativeRequest(request, {
        currentUrl: url,
        browserKey,
        visibleSessionId,
        obscured,
        designMode,
        pencilMode: designMode && pencilMode,
        bounds: () => boundsFor(slotRef),
        markOpen: (bounds) => {
          lastBounds.current = bounds;
          if (visibleSessionId) {
            attachedSessionRef.current = visibleSessionId;
            attachingSessionRef.current = undefined;
          }
        },
      })
      : performIframeRequest(request, {
        currentUrl: url,
        iframe: iframeRef,
        onLoaded,
      }),
  }), [browserKey, designMode, native, obscured, onLoaded, pencilMode, url, visibleSessionId]);

  useEffect(() => {
    return () => {
      if (native) detachNativeBrowser(visibleSessionId).catch(() => {});
    };
  }, [native, visibleSessionId]);

  return (
    <div ref={stageRef} className="relative h-full min-h-0 w-full overflow-hidden bg-[#070707]">
      <div
        ref={slotRef}
        className="absolute overflow-hidden rounded-[6px] bg-white shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_24px_80px_rgba(0,0,0,0.45)]"
        style={{
          left: surface.left,
          top: surface.top,
          width: surface.width,
          height: surface.height,
        }}
      >
        {!native && (
          <iframe
            ref={iframeRef}
            src={url}
            title="Droid Control browser"
            className="h-full w-full border-0 bg-white"
            sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
          />
        )}
      </div>
    </div>
  );
}

function readIframeUrl(iframe: HTMLIFrameElement): string | undefined {
  try {
    return iframe.contentWindow?.location.href;
  } catch {
    return undefined;
  }
}

async function performNativeRequest(
  request: BrowserNativeRequest,
  options: {
    currentUrl: string;
    browserKey: string;
    visibleSessionId?: string;
    obscured: boolean;
    designMode: boolean;
    pencilMode: boolean;
    bounds: () => NativeBrowserBounds | null;
    markOpen: (bounds: NativeBrowserBounds) => void;
  },
): Promise<BrowserNativeResult> {
  try {
    if (request.action === 'close') {
      await closeNativeBrowser(request.sessionId);
      return { requestId: request.requestId, missionId: request.missionId, ok: true };
    }
    const bounds = options.bounds();
    // While a full-screen overlay (settings, context meter, spec/question modal)
    // obscures the pane, the BrowserView is detached; treat the surface as not
    // visible so an `open`/`reload` doesn't reattach the OS layer over the overlay.
    const visible = !options.obscured && nativeBrowserRequestTargetsVisibleSurface({
      browserKey: options.browserKey,
      visibleSessionId: options.visibleSessionId,
      requestMissionId: request.missionId,
      requestSessionId: request.sessionId,
    });
    const visibleBounds = visible ? requireNativeBrowserBounds(bounds) : undefined;
    await syncNativeDesignState(request.sessionId, visible ? options.designMode : false, visible ? options.pencilMode : false);
    if (request.action === 'open') {
      const targetUrl = request.url ?? options.currentUrl;
      const loaded = waitForNextNativeBrowserLoad(request.sessionId).catch(() => undefined);
      await openNativeBrowser(request.sessionId, targetUrl, visibleBounds, request.viewport);
      if (visibleBounds) options.markOpen(visibleBounds);
      const loadedEvent = await loaded;
      return { requestId: request.requestId, missionId: request.missionId, ok: true, snapshot: navigationSnapshot(loadedEvent?.url ?? targetUrl) };
    }
    if (request.action === 'reload') {
      const loaded = waitForNextNativeBrowserLoad(request.sessionId).catch(() => undefined);
      await reloadNativeBrowser(request.sessionId);
      const loadedEvent = await loaded;
      return { requestId: request.requestId, missionId: request.missionId, ok: true, snapshot: navigationSnapshot(loadedEvent?.url ?? options.currentUrl) };
    }
    if (request.action === 'capture') {
      const image = await nativeBrowserCapture(request.sessionId, request.box, {
        fullPage: request.fullPage,
        deviceScaleFactor: request.deviceScaleFactor,
      });
      return { requestId: request.requestId, missionId: request.missionId, ok: true, image };
    }
    const result = await runNativeBrowserAgentAction({
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: request.action,
      x: request.x,
      y: request.y,
      text: request.text,
      key: request.key,
      direction: request.direction,
      pixels: request.pixels,
    });
    return { requestId: request.requestId, missionId: request.missionId, ok: result.ok, snapshot: result.snapshot, error: result.error };
  } catch (err) {
    return {
      requestId: request.requestId,
      missionId: request.missionId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function requireNativeBrowserBounds(bounds: NativeBrowserBounds | null): NativeBrowserBounds {
  if (!bounds) throw new Error('Droid Control browser pane is not laid out yet.');
  return bounds;
}

async function syncNativeDesignState(sessionId: string, designMode: boolean, pencilMode: boolean): Promise<void> {
  await setNativeBrowserDesignMode(sessionId, designMode);
  await setNativeBrowserPencilMode(sessionId, designMode && pencilMode);
}

async function performIframeRequest(
  request: BrowserNativeRequest,
  options: {
    currentUrl: string;
    iframe: RefObject<HTMLIFrameElement | null>;
    onLoaded: (url: string) => void;
  },
): Promise<BrowserNativeResult> {
  try {
    const iframe = options.iframe.current;
    if (!iframe) throw new Error('Droid Control browser pane is not mounted yet.');
    if (request.action === 'close') {
      iframe.src = 'about:blank';
      options.onLoaded('about:blank');
      return { requestId: request.requestId, missionId: request.missionId, ok: true };
    }
    if (request.action === 'open') {
      const targetUrl = request.url ?? options.currentUrl;
      await loadIframe(iframe, targetUrl);
      options.onLoaded(readIframeUrl(iframe) ?? targetUrl);
      return {
        requestId: request.requestId,
        missionId: request.missionId,
        ok: true,
        snapshot: safeIframeSnapshot(iframe, targetUrl),
      };
    }
    if (request.action === 'reload') {
      await loadIframe(iframe, readIframeUrl(iframe) ?? options.currentUrl);
      options.onLoaded(readIframeUrl(iframe) ?? options.currentUrl);
      return {
        requestId: request.requestId,
        missionId: request.missionId,
        ok: true,
        snapshot: safeIframeSnapshot(iframe, options.currentUrl),
      };
    }
    if (request.action === 'click') {
      await clickIframe(iframe, Number(request.x), Number(request.y));
    } else if (request.action === 'type') {
      await typeIntoIframe(iframe, request.text ?? '');
    } else if (request.action === 'keypress') {
      await keypressIframe(iframe, request.key ?? '');
    } else if (request.action === 'scroll') {
      await scrollIframe(iframe, request.direction ?? 'down', request.pixels);
    } else if (request.action === 'capture') {
      return { requestId: request.requestId, missionId: request.missionId, ok: true };
    } else if (request.action !== 'snapshot') {
      throw new Error(`Unsupported browser action: ${request.action}`);
    }
    await settleFrame();
    return {
      requestId: request.requestId,
      missionId: request.missionId,
      ok: true,
      snapshot: safeIframeSnapshot(iframe, options.currentUrl),
    };
  } catch (err) {
    return {
      requestId: request.requestId,
      missionId: request.missionId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function loadIframe(iframe: HTMLIFrameElement, url: string): Promise<void> {
  return new Promise((resolve) => {
    const targetUrl = absolutizeUrl(url);
    const startedAt = Date.now();
    iframe.src = url;
    const poll = () => {
      const currentUrl = readIframeUrl(iframe);
      if (currentUrl && currentUrl === targetUrl) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 5_000) {
        resolve();
        return;
      }
      window.setTimeout(poll, 50);
    };
    poll();
  });
}

function absolutizeUrl(url: string): string {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

function safeIframeSnapshot(iframe: HTMLIFrameElement, fallbackUrl: string) {
  try {
    return snapshotIframe(iframe, fallbackUrl);
  } catch {
    return { url: readIframeUrl(iframe) ?? fallbackUrl, scroll: { x: 0, y: 0 }, refs: [] };
  }
}

function navigationSnapshot(url: string) {
  return { url, scroll: { x: 0, y: 0 }, refs: [] };
}

function settleFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function surfaceLayout(frame: Size, viewport: BrowserViewport, mode: BrowserViewportMode) {
  const padding = 18;
  const availableWidth = Math.max(1, frame.width - padding * 2);
  const availableHeight = Math.max(1, frame.height - padding * 2);
  const width = mode === 'fit' ? availableWidth : Math.min(viewport.width, availableWidth);
  const height = mode === 'fit' ? availableHeight : Math.min(viewport.height, availableHeight);
  return {
    width: Math.round(width),
    height: Math.round(height),
    left: Math.round((frame.width - width) / 2),
    top: Math.round((frame.height - height) / 2),
  };
}

function boundsFor(ref: RefObject<HTMLElement | null>): NativeBrowserBounds | null {
  const node = ref.current;
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function equalBounds(a: NativeBrowserBounds, b: NativeBrowserBounds): boolean {
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}
