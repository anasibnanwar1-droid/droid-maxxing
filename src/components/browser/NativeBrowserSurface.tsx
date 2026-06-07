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
  closeNativeBrowser,
  onNativeBrowserDesignPrompt,
  onNativeBrowserLoaded,
  onNativeBrowserSelection,
  openNativeBrowser,
  runNativeBrowserAgentAction,
  setNativeBrowserBounds,
  setNativeBrowserDesignMode,
  setNativeBrowserSketchMode,
  waitForNextNativeBrowserLoad,
  type NativeBrowserBounds,
  type NativeBrowserDesignPrompt,
  type NativeBrowserSelection,
  reloadNativeBrowser,
} from '../../lib/nativeBrowser';
import { registerNativeBrowserController } from '../../lib/nativeBrowserAgent';
import type { BrowserNativeRequest, BrowserNativeResult, BrowserViewport, BrowserViewportMode } from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';
import { useElementSize } from './useElementSize';

interface NativeBrowserSurfaceProps {
  url: string;
  viewport: BrowserViewport;
  viewportMode: BrowserViewportMode;
  designMode: boolean;
  sketchMode: boolean;
  onLoaded: (url: string) => void;
  onSelection: (selection: NativeBrowserSelection) => void;
  onPrompt: (prompt: NativeBrowserDesignPrompt) => void;
  onViewportSizeChange: (size: Size) => void;
}

export function NativeBrowserSurface({
  url,
  viewport,
  viewportMode,
  designMode,
  sketchMode,
  onLoaded,
  onSelection,
  onPrompt,
  onViewportSizeChange,
}: NativeBrowserSurfaceProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const frameSize = useElementSize(stageRef);
  const lastUrl = useRef<string | null>(null);
  const lastBounds = useRef<NativeBrowserBounds | null>(null);
  const native = isDesktop();
  const surface = useMemo(
    () => surfaceLayout(frameSize, viewport, viewportMode),
    [frameSize, viewport, viewportMode],
  );

  useEffect(() => {
    onViewportSizeChange({ width: Math.round(surface.width), height: Math.round(surface.height) });
  }, [onViewportSizeChange, surface.height, surface.width]);

  useEffect(() => {
    setNativeBrowserDesignMode(designMode).catch(() => {});
  }, [designMode]);

  useEffect(() => {
    setNativeBrowserSketchMode(designMode && sketchMode).catch(() => {});
  }, [designMode, sketchMode]);

  useEffect(() => {
    let selectionUnlisten: (() => void) | undefined;
    let promptUnlisten: (() => void) | undefined;
    let loadedUnlisten: (() => void) | undefined;
    void onNativeBrowserSelection(onSelection).then((unlisten) => { selectionUnlisten = unlisten; });
    void onNativeBrowserDesignPrompt(onPrompt).then((unlisten) => { promptUnlisten = unlisten; });
    void onNativeBrowserLoaded((event) => onLoaded(event.url)).then((unlisten) => { loadedUnlisten = unlisten; });
    return () => {
      selectionUnlisten?.();
      promptUnlisten?.();
      loadedUnlisten?.();
    };
  }, [onLoaded, onPrompt, onSelection]);

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
          sketchMode,
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
  }, [designMode, native, onLoaded, onSelection, sketchMode, url]);

  useEffect(() => {
    if (!native) return;
    const bounds = boundsFor(slotRef);
    if (!bounds) return;
    const sameUrl = lastUrl.current === url;
    const sameBounds = lastBounds.current && equalBounds(lastBounds.current, bounds);
    if (!sameUrl) {
      openNativeBrowser(url, bounds).catch(() => {});
      lastUrl.current = url;
      lastBounds.current = bounds;
      return;
    }
    if (!sameBounds) {
      setNativeBrowserBounds(bounds).catch(() => {});
      lastBounds.current = bounds;
    }
  }, [native, surface.height, surface.left, surface.top, surface.width, url]);

  useEffect(() => registerNativeBrowserController({
    perform: async (request) => native
      ? performNativeRequest(request, {
        currentUrl: url,
        bounds: () => boundsFor(slotRef),
        markOpen: (nextUrl, bounds) => {
          lastUrl.current = nextUrl;
          lastBounds.current = bounds;
        },
      })
      : performIframeRequest(request, {
        currentUrl: url,
        iframe: iframeRef,
        onLoaded,
      }),
  }), [native, onLoaded, url]);

  useEffect(() => {
    return () => {
      if (native) closeNativeBrowser().catch(() => {});
    };
  }, [native]);

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
    bounds: () => NativeBrowserBounds | null;
    markOpen: (url: string, bounds: NativeBrowserBounds) => void;
  },
): Promise<BrowserNativeResult> {
  try {
    if (request.action === 'close') {
      await closeNativeBrowser();
      return { requestId: request.requestId, missionId: request.missionId, ok: true };
    }
    const bounds = options.bounds();
    if (!bounds) throw new Error('Droid Control browser pane is not laid out yet.');
    if (request.action === 'open') {
      const targetUrl = request.url ?? options.currentUrl;
      const loaded = waitForNextNativeBrowserLoad().catch(() => undefined);
      await openNativeBrowser(targetUrl, bounds);
      options.markOpen(targetUrl, bounds);
      await loaded;
      const result = await runNativeBrowserAgentAction({ requestId: request.requestId, action: 'snapshot' });
      return { requestId: request.requestId, missionId: request.missionId, ok: result.ok, snapshot: result.snapshot, error: result.error };
    }
    if (request.action === 'reload') {
      const loaded = waitForNextNativeBrowserLoad().catch(() => undefined);
      await reloadNativeBrowser();
      await loaded;
      const result = await runNativeBrowserAgentAction({ requestId: request.requestId, action: 'snapshot' });
      return { requestId: request.requestId, missionId: request.missionId, ok: result.ok, snapshot: result.snapshot, error: result.error };
    }
    const result = await runNativeBrowserAgentAction({
      requestId: request.requestId,
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
