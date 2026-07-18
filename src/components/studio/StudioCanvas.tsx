import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useStudioCanvas, sizeOf, type StudioFrame } from './StudioCanvasContext';
import {
  fitRects,
  panBy,
  rectFromPoints,
  rectsIntersect,
  screenToWorld,
  worldToScreen,
  zoomAtPoint,
  type CanvasView,
  type Point,
  type Rect,
} from './studioCanvasMath';
import StudioFrameBody from './StudioFrameBody';
import StudioFrameChrome from './StudioFrameChrome';
import CanvasControls from './CanvasControls';
import CanvasEmptyState from './CanvasEmptyState';

type DragMode = 'pan' | 'marquee';

export default function StudioCanvas({ onRequestAddFrame }: { onRequestAddFrame: () => void }) {
  const { studio, studioDispatch } = useStudioCanvas();
  const { view, tool, frames, selectedFrameIds } = studio;
  const rootRef = useRef<HTMLDivElement>(null);
  // Latest view for the native wheel listener (bound once, reads via ref).
  const viewRef = useRef(view);
  viewRef.current = view;
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const prevFrameCount = useRef(frames.length);
  const rafRef = useRef<number | null>(null);
  const drag = useRef<{
    mode: DragMode;
    startClient: Point;
    startPan: Point;
    moved: boolean;
  } | null>(null);

  // Ease the view (pan + zoom together) to a target so frames, labels, and grid
  // all move in sync — a snap would desync the screen-space chrome.
  const animateView = useCallback(
    (target: CanvasView) => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      const start = viewRef.current;
      const t0 = performance.now();
      const dur = 500;
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / dur);
        const k = 1 - Math.pow(1 - t, 3);
        studioDispatch({
          type: 'SET_VIEW',
          view: {
            zoom: start.zoom + (target.zoom - start.zoom) * k,
            pan: {
              x: start.pan.x + (target.pan.x - start.pan.x) * k,
              y: start.pan.y + (target.pan.y - start.pan.y) * k,
            },
          },
        });
        if (t < 1) rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [studioDispatch],
  );

  const stopAnimation = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  // Fly the canvas to a newly added frame so focus lands on the new work.
  // A thread-switch HYDRATE swaps the whole set and must restore the saved
  // view untouched, so skip the fly-to right after one.
  const hydrateSeen = useRef(studio.hydrateCount);
  // True only during the render that swapped in a restored thread (the effect
  // below syncs the ref right after) — used to mount frames without animation.
  const restoring = studio.hydrateCount !== hydrateSeen.current;
  useEffect(() => {
    const hydrated = studio.hydrateCount !== hydrateSeen.current;
    hydrateSeen.current = studio.hydrateCount;
    if (!hydrated && frames.length > prevFrameCount.current) {
      const added = frames[frames.length - 1];
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect) {
        const size = sizeOf(added);
        const target = fitRects(
          [{ x: added.x, y: added.y, width: size.width, height: size.height }],
          { width: rect.width, height: rect.height },
          180,
        );
        animateView(target);
      }
    }
    prevFrameCount.current = frames.length;
  }, [frames, studio.hydrateCount, animateView]);

  useEffect(() => stopAnimation, [stopAnimation]);

  // Esc leaves interact mode. Capture phase + stopPropagation so it doesn't also
  // close the whole studio (whose Esc listener sits on window in the bubble phase).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && studio.interactingFrameId) {
        e.stopPropagation();
        studioDispatch({ type: 'SET_INTERACTING', id: null });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [studio.interactingFrameId, studioDispatch]);

  const localPoint = useCallback((clientX: number, clientY: number): Point => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  // Space-to-pan, like every real canvas.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const wantsPan = tool === 'hand' || spaceHeld;

  // Wheel must be a native, non-passive listener: React 18 registers `wheel` as
  // passive at the root, so preventDefault there is a no-op and ctrl/⌘-scroll
  // would zoom the whole Electron page instead of the canvas.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      const v = viewRef.current;
      const rect = node.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.pow(1.0016, -e.deltaY);
        studioDispatch({ type: 'SET_VIEW', view: zoomAtPoint(v, factor, anchor) });
      } else {
        studioDispatch({ type: 'SET_VIEW', view: panBy(v, -e.deltaX, -e.deltaY) });
      }
    };
    node.addEventListener('wheel', onWheelNative, { passive: false });
    return () => {
      node.removeEventListener('wheel', onWheelNative);
    };
  }, [studioDispatch]);

  const onPointerDown = (e: ReactPointerEvent) => {
    stopAnimation();
    // A click on empty canvas exits interact mode (clicks on the frame itself go
    // to the live app, not here).
    if (studio.interactingFrameId) {
      studioDispatch({ type: 'SET_INTERACTING', id: null });
      return;
    }
    if (e.button === 1 || wantsPan) {
      drag.current = {
        mode: 'pan',
        startClient: { x: e.clientX, y: e.clientY },
        startPan: view.pan,
        moved: false,
      };
    } else if (tool === 'select') {
      drag.current = {
        mode: 'marquee',
        startClient: { x: e.clientX, y: e.clientY },
        startPan: view.pan,
        moved: false,
      };
    } else {
      return;
    }
    rootRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startClient.x;
    const dy = e.clientY - d.startClient.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
    if (d.mode === 'pan') {
      studioDispatch({
        type: 'SET_VIEW',
        view: { ...view, pan: { x: d.startPan.x + dx, y: d.startPan.y + dy } },
      });
    } else {
      const a = localPoint(d.startClient.x, d.startClient.y);
      const b = localPoint(e.clientX, e.clientY);
      setMarquee(rectFromPoints(a, b));
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    rootRef.current?.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.mode === 'marquee') {
      if (d.moved && marquee) {
        const worldA = screenToWorld({ x: marquee.x, y: marquee.y }, view);
        const worldB = screenToWorld(
          { x: marquee.x + marquee.width, y: marquee.y + marquee.height },
          view,
        );
        const worldRect = rectFromPoints(worldA, worldB);
        const hits = frames
          .filter((f) => rectsIntersect(worldRect, frameWorldRect(f)))
          .map((f) => f.id);
        studioDispatch({ type: 'SELECT_FRAMES', ids: hits });
      } else {
        // Bare click on empty canvas clears both frame and element selection.
        studioDispatch({ type: 'SELECT_FRAMES', ids: [] });
        studioDispatch({ type: 'CLEAR_SELECTION' });
      }
    }
    setMarquee(null);
  };

  const duplicateFrame = (frame: StudioFrame) => {
    studioDispatch({
      type: 'ADD_FRAME',
      frame: { name: `${frame.name} copy`, url: frame.url, mode: frame.mode, kind: frame.kind },
    });
  };

  const cursor = wantsPan
    ? drag.current?.mode === 'pan'
      ? 'grabbing'
      : 'grab'
    : tool === 'frame'
      ? 'crosshair'
      : 'default';

  const gridSize = 26 * view.zoom;

  return (
    <div
      ref={rootRef}
      className="relative h-full w-full overflow-hidden bg-droid-bg select-none"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Dot grid, anchored to the world so it tracks pan/zoom */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, color-mix(in srgb, var(--droid-text) 7%, transparent) 1px, transparent 1px)',
          backgroundSize: `${String(gridSize)}px ${String(gridSize)}px`,
          backgroundPosition: `${String(view.pan.x)}px ${String(view.pan.y)}px`,
          opacity: Math.min(1, 0.35 + view.zoom * 0.4),
        }}
      />
      {/* Depth vignette — eases off when zoomed out so the canvas feels open. */}
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-300"
        style={{
          background:
            'radial-gradient(120% 120% at 50% 40%, transparent 40%, rgba(0,0,0,0.6) 100%)',
          opacity: Math.min(0.7, 0.28 + view.zoom * 0.22),
        }}
      />

      {/* World layer — scaled; frame bodies are visual only (pointer-events none)
          so pan/marquee always work over them. */}
      <div
        className="pointer-events-none absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate3d(${String(view.pan.x)}px, ${String(view.pan.y)}px, 0) scale(${String(view.zoom)})`,
        }}
      >
        {frames.map((f) => (
          <StudioFrameBody key={f.id} frame={f} entrance={!restoring} />
        ))}
      </div>

      {/* Chrome overlay — crisp, screen-space */}
      <div className="pointer-events-none absolute inset-0">
        {frames.map((f) => {
          const size = sizeOf(f);
          const tl = worldToScreen({ x: f.x, y: f.y }, view);
          const rect: Rect = {
            x: tl.x,
            y: tl.y,
            width: size.width * view.zoom,
            height: size.height * view.zoom,
          };
          return (
            <StudioFrameChrome
              key={f.id}
              frame={f}
              rect={rect}
              zoom={view.zoom}
              tool={tool}
              selected={selectedFrameIds.includes(f.id)}
              onDuplicate={duplicateFrame}
            />
          );
        })}
      </div>

      {/* Marquee */}
      {marquee && (
        <div
          className="pointer-events-none absolute rounded-[3px] border border-[#ee6018]/70 bg-[#ee6018]/10"
          style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }}
        />
      )}

      {frames.length === 0 && <CanvasEmptyState onAddFrame={onRequestAddFrame} />}

      <CanvasControls
        getSize={() => {
          const r = rootRef.current?.getBoundingClientRect();
          return r ? { width: r.width, height: r.height } : null;
        }}
        onRequestAddFrame={onRequestAddFrame}
      />
    </div>
  );
}

function frameWorldRect(f: StudioFrame): Rect {
  const size = sizeOf(f);
  return { x: f.x, y: f.y, width: size.width, height: size.height };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}
