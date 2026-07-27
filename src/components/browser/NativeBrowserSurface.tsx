import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { isDesktop } from '../../lib/desktop';
import {
  attachIframeDesignMode,
  clickIframe,
  hoverIframe,
  keypressIframe,
  scrollIframe,
  selectOptionIframe,
  snapshotIframe,
  typeIntoIframe,
} from '../../lib/iframeDesignMode';
import {
  attachNativeBrowser,
  closeNativeBrowser,
  detachNativeBrowser,
  goBackNativeBrowser,
  goForwardNativeBrowser,
  onNativeBrowserDesignPrompt,
  onNativeBrowserLoadFailed,
  onNativeBrowserLoaded,
  onNativeBrowserSelection,
  openNativeBrowser,
  nativeBrowserAgentActionFromRequest,
  nativeBrowserCapture,
  runNativeBrowserAgentAction,
  setNativeBrowserBounds,
  setNativeBrowserDesignMode,
  setNativeBrowserPencilMode,
  setNativeBrowserVisible,
  waitForNextNativeBrowserLoad,
  type NativeBrowserBounds,
  type NativeBrowserDesignPrompt,
  type NativeBrowserLoadFailed,
  type NativeBrowserLoaded,
  type NativeBrowserSelection,
  reloadNativeBrowser,
} from '../../lib/nativeBrowser';
import { registerNativeBrowserController } from '../../lib/nativeBrowserAgent';
import { nativeBrowserRequestTargetsVisibleSurface } from '../../lib/browserSessionIdentity';
import type {
  BrowserNativeRequest,
  BrowserNativeResult,
  BrowserViewport,
  BrowserViewportMode,
} from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';

interface NativeBrowserSurfaceProps {
  browserKey: string;
  visibleBrowserSessionId?: string;
  obscured?: boolean;
  url: string;
  viewport: BrowserViewport;
  viewportMode: BrowserViewportMode;
  designMode: boolean;
  pencilMode: boolean;
  expanded?: boolean;
  frameSize: Size;
  onLoaded: (event: NativeBrowserLoaded) => void;
  onSelection: (selection: NativeBrowserSelection) => void;
  onPrompt: (prompt: NativeBrowserDesignPrompt) => void;
  onLoadFailed?: (failure: NativeBrowserLoadFailed) => void;
  onViewportSizeChange: (size: Size) => void;
}

export function NativeBrowserSurface({
  browserKey,
  visibleBrowserSessionId,
  obscured = false,
  url,
  viewport,
  viewportMode,
  designMode,
  pencilMode,
  expanded = false,
  frameSize,
  onLoaded,
  onSelection,
  onPrompt,
  onLoadFailed,
  onViewportSizeChange,
}: NativeBrowserSurfaceProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const surfaceReady = frameSize.width > 8 && frameSize.height > 8;
  const lastBounds = useRef<NativeBrowserBounds | null>(null);
  const pendingBounds = useRef<{
    browserSessionId: string;
    bounds: NativeBrowserBounds;
  } | null>(null);
  const boundsFrame = useRef(0);
  const attachedSessionRef = useRef<string | undefined>(undefined);
  const attachingSessionRef = useRef<string | undefined>(undefined);
  const onLoadedRef = useRef(onLoaded);
  const onSelectionRef = useRef(onSelection);
  const onPromptRef = useRef(onPrompt);
  const onLoadFailedRef = useRef(onLoadFailed);
  const obscuredRef = useRef(obscured);
  const controllerStateRef = useRef({
    browserKey,
    designMode,
    obscured,
    pencilMode,
    url,
    visibleBrowserSessionId,
  });
  controllerStateRef.current = {
    browserKey,
    designMode,
    obscured,
    pencilMode,
    url,
    visibleBrowserSessionId,
  };
  const urlRef = useRef(url);
  urlRef.current = url;
  const native = isDesktop();
  const surface = useMemo(
    () => surfaceLayout(frameSize, viewport, viewportMode, expanded),
    [expanded, frameSize, viewport, viewportMode],
  );
  const scheduleBoundsUpdate = useCallback(
    (browserSessionId: string, bounds: NativeBrowserBounds) => {
      pendingBounds.current = { browserSessionId, bounds };
      if (boundsFrame.current) return;
      boundsFrame.current = requestAnimationFrame(() => {
        boundsFrame.current = 0;
        const pending = pendingBounds.current;
        pendingBounds.current = null;
        if (!pending) return;
        lastBounds.current = pending.bounds;
        setNativeBrowserBounds(pending.browserSessionId, pending.bounds).catch(() => {});
      });
    },
    [],
  );

  useEffect(
    () => () => {
      if (boundsFrame.current) cancelAnimationFrame(boundsFrame.current);
    },
    [],
  );

  useEffect(() => {
    onLoadedRef.current = onLoaded;
    onSelectionRef.current = onSelection;
    onPromptRef.current = onPrompt;
    onLoadFailedRef.current = onLoadFailed;
    obscuredRef.current = obscured;
  }, [obscured, onLoadFailed, onLoaded, onPrompt, onSelection]);

  useEffect(() => {
    onViewportSizeChange({ width: Math.round(surface.width), height: Math.round(surface.height) });
  }, [onViewportSizeChange, surface.height, surface.width]);

  useEffect(() => {
    if (!visibleBrowserSessionId) return;
    const designActive = !obscured && designMode;
    Promise.all([
      setNativeBrowserDesignMode(visibleBrowserSessionId, designActive),
      setNativeBrowserPencilMode(visibleBrowserSessionId, designActive && pencilMode),
    ]).catch(() => {});
  }, [designMode, obscured, pencilMode, visibleBrowserSessionId]);

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

    track(
      onNativeBrowserSelection((selection) => {
        if (selection.browserSessionId && selection.browserSessionId !== visibleBrowserSessionId)
          return;
        onSelectionRef.current(selection);
      }),
    );
    track(
      onNativeBrowserDesignPrompt((prompt) => {
        if (
          prompt.selection.browserSessionId &&
          prompt.selection.browserSessionId !== visibleBrowserSessionId
        )
          return;
        onPromptRef.current(prompt);
      }),
    );
    track(
      onNativeBrowserLoaded((event) => {
        if (event.browserSessionId && event.browserSessionId !== visibleBrowserSessionId) return;
        onLoadedRef.current(event);
      }),
    );
    track(
      onNativeBrowserLoadFailed((failure) => {
        if (failure.browserSessionId && failure.browserSessionId !== visibleBrowserSessionId)
          return;
        onLoadFailedRef.current?.(failure);
      }),
    );

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [visibleBrowserSessionId]);

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
          onSelection: (selection) => onSelectionRef.current(selection),
        });
        onLoadedRef.current({
          browserSessionId: visibleBrowserSessionId ?? browserKey,
          url: readIframeUrl(iframe) ?? url,
        });
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
  }, [browserKey, designMode, native, pencilMode, url, visibleBrowserSessionId]);

  useLayoutEffect(() => {
    if (!native) return;
    if (visibleBrowserSessionId) {
      setNativeBrowserVisible(visibleBrowserSessionId, !obscured).catch(() => {});
    }
  }, [native, obscured, visibleBrowserSessionId]);

  useEffect(() => {
    if (!native) return;
    if (obscured) {
      return;
    }
    if (!surfaceReady) return;
    const bounds = boundsFor(slotRef);
    if (!bounds) return;
    if (!visibleBrowserSessionId) {
      pendingBounds.current = null;
      detachNativeBrowser().catch(() => {});
      attachedSessionRef.current = undefined;
      attachingSessionRef.current = undefined;
      lastBounds.current = null;
      return;
    }
    if (attachedSessionRef.current !== visibleBrowserSessionId) {
      // Avoid duplicate attaches while one is in flight, and only mark the
      // session attached once attachNativeBrowser actually resolves so a failed
      // attach can be retried by a later effect run.
      if (attachingSessionRef.current === visibleBrowserSessionId) return;
      const target = visibleBrowserSessionId;
      attachingSessionRef.current = target;
      attachNativeBrowser(target, bounds, urlRef.current)
        .then(() => {
          // A newer session may have started attaching while this was in
          // flight; only commit state if `target` is still the intended one.
          if (attachingSessionRef.current !== target) return;
          attachedSessionRef.current = target;
          lastBounds.current = bounds;
          if (obscuredRef.current) {
            setNativeBrowserVisible(target, false).catch(() => {});
          }
        })
        .catch(() => {})
        .finally(() => {
          if (attachingSessionRef.current === target) attachingSessionRef.current = undefined;
        });
      return;
    }
    if (!lastBounds.current || !equalBounds(lastBounds.current, bounds)) {
      scheduleBoundsUpdate(visibleBrowserSessionId, bounds);
    }
  }, [
    native,
    obscured,
    surface.height,
    surface.left,
    surface.top,
    surface.width,
    surfaceReady,
    scheduleBoundsUpdate,
    visibleBrowserSessionId,
  ]);

  useEffect(
    () =>
      registerNativeBrowserController({
        perform: async (request) => {
          const current = controllerStateRef.current;
          return native
            ? performNativeRequest(request, {
                currentUrl: current.url,
                browserKey: current.browserKey,
                visibleBrowserSessionId: current.visibleBrowserSessionId,
                obscured: current.obscured,
                designMode: current.designMode,
                pencilMode: current.designMode && current.pencilMode,
                bounds: () => boundsFor(slotRef),
                markOpen: (bounds) => {
                  lastBounds.current = bounds;
                  if (current.visibleBrowserSessionId) {
                    attachedSessionRef.current = current.visibleBrowserSessionId;
                    attachingSessionRef.current = undefined;
                  }
                },
              })
            : performIframeRequest(request, {
                currentUrl: current.url,
                iframe: iframeRef,
                onLoaded: (url) =>
                  onLoadedRef.current({ browserSessionId: request.browserSessionId, url }),
              });
        },
      }),
    [native],
  );

  useEffect(() => {
    return () => {
      if (native) detachNativeBrowser(visibleBrowserSessionId).catch(() => {});
    };
  }, [native, visibleBrowserSessionId]);

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden bg-[#070707]">
      <div
        ref={slotRef}
        className={`absolute overflow-hidden bg-white ${
          expanded
            ? 'rounded-none'
            : 'rounded-[6px] shadow-[0_0_0_1px_rgba(255,255,255,0.1),0_24px_80px_rgba(0,0,0,0.45)]'
        }`}
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
    visibleBrowserSessionId?: string;
    obscured: boolean;
    designMode: boolean;
    pencilMode: boolean;
    bounds: () => NativeBrowserBounds | null;
    markOpen: (bounds: NativeBrowserBounds) => void;
  },
): Promise<BrowserNativeResult> {
  try {
    if (request.action === 'close') {
      await closeNativeBrowser(request.browserSessionId);
      return { requestId: request.requestId, appSessionId: request.appSessionId, ok: true };
    }
    const bounds = options.bounds();
    // While a full-screen overlay (settings, context meter, spec/question modal)
    // obscures the pane, the BrowserView is detached; treat the surface as not
    // visible so an `open`/`reload` doesn't reattach the OS layer over the overlay.
    const visible =
      !options.obscured &&
      nativeBrowserRequestTargetsVisibleSurface({
        browserKey: options.browserKey,
        visibleBrowserSessionId: options.visibleBrowserSessionId,
        requestAppSessionId: request.appSessionId,
        requestBrowserSessionId: request.browserSessionId,
      });
    const visibleBounds = visible ? requireNativeBrowserBounds(bounds) : undefined;
    if (visibleBounds && request.action !== 'open') {
      await setNativeBrowserBounds(request.browserSessionId, visibleBounds);
    }
    await syncNativeDesignState(
      request.browserSessionId,
      visible ? options.designMode : false,
      visible ? options.pencilMode : false,
    );
    if (request.action === 'open') {
      const targetUrl = request.url ?? options.currentUrl;
      const loaded = waitForNextNativeBrowserLoad(request.browserSessionId).catch(() => undefined);
      await openNativeBrowser(request.browserSessionId, targetUrl, visibleBounds, request.viewport);
      if (visibleBounds) options.markOpen(visibleBounds);
      const loadedEvent = await loaded;
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        ok: true,
        snapshot: await snapshotAfterNavigation(request, loadedEvent?.url ?? targetUrl),
      };
    }
    if (request.action === 'reload') {
      const loaded = waitForNextNativeBrowserLoad(request.browserSessionId).catch(() => undefined);
      await reloadNativeBrowser(request.browserSessionId);
      const loadedEvent = await loaded;
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        ok: true,
        snapshot: await snapshotAfterNavigation(request, loadedEvent?.url ?? options.currentUrl),
      };
    }
    if (request.action === 'goBack' || request.action === 'goForward') {
      const loaded = waitForNextNativeBrowserLoad(request.browserSessionId).catch(() => undefined);
      const moved =
        request.action === 'goBack'
          ? await goBackNativeBrowser(request.browserSessionId)
          : await goForwardNativeBrowser(request.browserSessionId);
      if (!moved) {
        return {
          requestId: request.requestId,
          appSessionId: request.appSessionId,
          ok: true,
          snapshot: await snapshotAfterNavigation(request, options.currentUrl),
        };
      }
      const loadedEvent = await loaded;
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        ok: true,
        snapshot: await snapshotAfterNavigation(request, loadedEvent?.url ?? options.currentUrl),
      };
    }
    if (request.action === 'capture') {
      const image = await nativeBrowserCapture(request.browserSessionId, request.box, {
        fullPage: request.fullPage,
        deviceScaleFactor: request.deviceScaleFactor,
      });
      return { requestId: request.requestId, appSessionId: request.appSessionId, ok: true, image };
    }
    const result = await runNativeBrowserAgentAction(nativeBrowserAgentActionFromRequest(request));
    return {
      requestId: request.requestId,
      appSessionId: request.appSessionId,
      ok: result.ok,
      snapshot: result.snapshot,
      inspection: result.inspection,
      networkEvents: result.networkEvents,
      consoleEvents: result.consoleEvents,
      error: result.error,
    };
  } catch (err) {
    return {
      requestId: request.requestId,
      appSessionId: request.appSessionId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function requireNativeBrowserBounds(bounds: NativeBrowserBounds | null): NativeBrowserBounds {
  if (!bounds) throw new Error('Droid Control browser pane is not laid out yet.');
  return bounds;
}

async function syncNativeDesignState(
  browserSessionId: string,
  designMode: boolean,
  pencilMode: boolean,
): Promise<void> {
  await setNativeBrowserDesignMode(browserSessionId, designMode);
  await setNativeBrowserPencilMode(browserSessionId, designMode && pencilMode);
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
      return { requestId: request.requestId, appSessionId: request.appSessionId, ok: true };
    }
    if (request.action === 'open') {
      const targetUrl = request.url ?? options.currentUrl;
      await loadIframe(iframe, targetUrl);
      options.onLoaded(readIframeUrl(iframe) ?? targetUrl);
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        ok: true,
        snapshot: safeIframeSnapshot(iframe, targetUrl),
      };
    }
    if (request.action === 'reload') {
      await loadIframe(iframe, readIframeUrl(iframe) ?? options.currentUrl);
      options.onLoaded(readIframeUrl(iframe) ?? options.currentUrl);
      return {
        requestId: request.requestId,
        appSessionId: request.appSessionId,
        ok: true,
        snapshot: safeIframeSnapshot(iframe, options.currentUrl),
      };
    }
    if (request.action === 'click') {
      await clickIframe(iframe, Number(request.x), Number(request.y));
    } else if (request.action === 'hover') {
      await hoverIframe(iframe, Number(request.x), Number(request.y), request.selector);
    } else if (request.action === 'selectOption') {
      if (!request.selector) throw new Error('A selector is required to select an option.');
      await selectOptionIframe(iframe, request.selector, request.text ?? '');
    } else if (request.action === 'type') {
      await typeIntoIframe(iframe, request.text ?? '');
    } else if (request.action === 'keypress') {
      await keypressIframe(iframe, request.key ?? '');
    } else if (request.action === 'scroll') {
      await scrollIframe(iframe, request.direction ?? 'down', request.pixels);
    } else if (request.action === 'capture') {
      return { requestId: request.requestId, appSessionId: request.appSessionId, ok: true };
    } else if (request.action !== 'snapshot') {
      throw new Error(`Unsupported browser action: ${request.action}`);
    }
    await settleFrame();
    return {
      requestId: request.requestId,
      appSessionId: request.appSessionId,
      ok: true,
      snapshot: safeIframeSnapshot(iframe, options.currentUrl),
    };
  } catch (err) {
    return {
      requestId: request.requestId,
      appSessionId: request.appSessionId,
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

async function snapshotAfterNavigation(request: BrowserNativeRequest, fallbackUrl: string) {
  const result = await runNativeBrowserAgentAction({
    requestId: `${request.requestId}:snapshot`,
    browserSessionId: request.browserSessionId,
    action: 'snapshot',
  }).catch(() => undefined);
  return result?.ok && result.snapshot ? result.snapshot : navigationSnapshot(fallbackUrl);
}

function settleFrame(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function surfaceLayout(
  frame: Size,
  viewport: BrowserViewport,
  mode: BrowserViewportMode,
  expanded = false,
) {
  if (expanded && mode === 'fit') {
    return {
      width: Math.max(1, Math.round(frame.width)),
      height: Math.max(1, Math.round(frame.height)),
      left: 0,
      top: 0,
    };
  }
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
