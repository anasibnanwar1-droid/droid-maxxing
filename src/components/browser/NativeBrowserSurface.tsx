import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { isTauri } from '../../lib/tauri';
import {
  closeNativeBrowser,
  onNativeBrowserLoaded,
  onNativeBrowserSelection,
  openNativeBrowser,
  setNativeBrowserBounds,
  setNativeBrowserDesignMode,
  setNativeBrowserSketchMode,
  type NativeBrowserBounds,
  type NativeBrowserSelection,
} from '../../lib/nativeBrowser';
import type { BrowserViewport, BrowserViewportMode } from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';

interface NativeBrowserSurfaceProps {
  url: string;
  viewport: BrowserViewport;
  viewportMode: BrowserViewportMode;
  designMode: boolean;
  sketchMode: boolean;
  onLoaded: (url: string) => void;
  onSelection: (selection: NativeBrowserSelection) => void;
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
  onViewportSizeChange,
}: NativeBrowserSurfaceProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const frameSize = useElementSize(stageRef);
  const lastUrl = useRef<string | null>(null);
  const lastBounds = useRef<NativeBrowserBounds | null>(null);
  const native = isTauri();
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
    let loadedUnlisten: (() => void) | undefined;
    void onNativeBrowserSelection(onSelection).then((unlisten) => { selectionUnlisten = unlisten; });
    void onNativeBrowserLoaded((event) => onLoaded(event.url)).then((unlisten) => { loadedUnlisten = unlisten; });
    return () => {
      selectionUnlisten?.();
      loadedUnlisten?.();
    };
  }, [onLoaded, onSelection]);

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
            src={url}
            title="DroidMaxx browser"
            className="h-full w-full border-0 bg-white"
            sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
          />
        )}
      </div>
    </div>
  );
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

function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 1, height: 1 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setSize({ width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [ref]);

  return size;
}
