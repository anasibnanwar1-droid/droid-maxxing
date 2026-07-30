import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { pushEscapeLayer } from '../environment/usePopover';
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
import CanvasAnnotationLayer from './CanvasAnnotationLayer';
import CanvasImageLayer from './CanvasImageLayer';
import AnnotationToolbar from './AnnotationToolbar';
import { useCanvasDrawing } from './useCanvasDrawing';
import { useCanvasImageImport } from './useCanvasImageImport';
import { hitTestAnnotation, topFrameAtPoint } from './studioAnnotations';
import { CANVAS_IMAGE_INPUT_ID } from './studioCanvasImages';

type DragMode = 'pan' | 'marquee';

export default function StudioCanvas({
  cwd,
  onRequestAddFrame,
}: {
  cwd: string;
  onRequestAddFrame: () => void;
}) {
  const { studio, studioDispatch } = useStudioCanvas();
  const { view, tool, frames, selectedFrameIds } = studio;
  const rootRef = useRef<HTMLDivElement>(null);
  const drawing = useCanvasDrawing(rootRef);
  const imageImport = useCanvasImageImport(rootRef, cwd);
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

  // Interactive iframe mode is an Escape layer above the Studio itself.
  useEffect(() => {
    if (!studio.interactingFrameId) return;
    return pushEscapeLayer(() => {
      studioDispatch({ type: 'SET_INTERACTING', id: null });
    });
  }, [studio.interactingFrameId, studioDispatch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
        const shortcut = e.key.toLowerCase();
        const shortcutTool =
          shortcut === 'v'
            ? 'select'
            : shortcut === 'h'
              ? 'hand'
              : shortcut === 'p'
                ? 'draw'
                : null;
        if (shortcutTool) {
          e.preventDefault();
          studioDispatch({ type: 'SET_TOOL', tool: shortcutTool });
        } else if (shortcut === 'f') {
          e.preventDefault();
          studioDispatch({ type: 'SET_INTERACTING', id: null });
          onRequestAddFrame();
        }
      }
      if (studio.tool === 'draw' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        studioDispatch({ type: 'UNDO_ANNOTATION' });
      }
      if (
        (studio.selectedAnnotationId || studio.selectedImageId) &&
        (e.key === 'Delete' || e.key === 'Backspace') &&
        !isTypingTarget(e.target)
      ) {
        e.preventDefault();
        if (studio.selectedAnnotationId) {
          studioDispatch({ type: 'REMOVE_ANNOTATION', id: studio.selectedAnnotationId });
        } else if (studio.selectedImageId) {
          studioDispatch({ type: 'REMOVE_CANVAS_IMAGE', id: studio.selectedImageId });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [
    onRequestAddFrame,
    studio.selectedAnnotationId,
    studio.selectedImageId,
    studio.tool,
    studioDispatch,
  ]);

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
    // Canvas gestures must never capture the pointer from controls layered over
    // the canvas. Doing so retargets pointerup to the canvas and cancels the
    // control's click.
    if (isInteractiveCanvasTarget(e.target)) return;
    if (drawing.beginDrawing(e) || drawing.beginEdit(e)) {
      stopAnimation();
      return;
    }
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
    imageImport.trackPointer(e.clientX, e.clientY);
    if (drawing.move(e)) return;
    const d = drag.current;
    if (!d) {
      drawing.updateHover(e);
      return;
    }
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
    if (drawing.finish(e)) return;
    const d = drag.current;
    drag.current = null;
    if (rootRef.current?.hasPointerCapture(e.pointerId)) {
      rootRef.current.releasePointerCapture(e.pointerId);
    }
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
        studioDispatch({ type: 'SELECT_ANNOTATION', id: null });
        studioDispatch({ type: 'SELECT_CANVAS_IMAGE', id: null });
      }
    }
    setMarquee(null);
  };

  const duplicateFrame = (frame: StudioFrame) => {
    studioDispatch({
      type: 'ADD_FRAME',
      frame: {
        name: `${frame.name} copy`,
        url: frame.url,
        ...(frame.source === undefined ? {} : { source: frame.source }),
        mode: frame.mode,
        kind: frame.kind,
      },
    });
  };

  const onDoubleClick = (event: ReactMouseEvent) => {
    if (isInteractiveCanvasTarget(event.target)) return;
    const screen = localPoint(event.clientX, event.clientY);
    const world = screenToWorld(screen, view);
    const overFrame = topFrameAtPoint(frames, world) !== undefined;
    const overImage = studio.images.some(
      (image) =>
        world.x >= image.x &&
        world.x <= image.x + image.width &&
        world.y >= image.y &&
        world.y <= image.y + image.height,
    );
    const overAnnotation = studio.annotations.some((annotation) =>
      hitTestAnnotation(annotation, screen, frames, view),
    );
    if (overFrame || overImage || overAnnotation) return;
    drawing.cancel();
    studioDispatch({ type: 'SET_TOOL', tool: 'select' });
    studioDispatch({ type: 'SET_INTERACTING', id: null });
  };

  const cursor = wantsPan
    ? drag.current?.mode === 'pan'
      ? 'grabbing'
      : 'grab'
    : (drawing.cursor ??
      (tool === 'frame' ? 'crosshair' : tool === 'draw' ? 'crosshair' : 'default'));

  const gridSize = 26 * view.zoom;
  const requestAddFrame = () => {
    studioDispatch({ type: 'SET_INTERACTING', id: null });
    onRequestAddFrame();
  };

  return (
    <div
      ref={rootRef}
      className="studio-canvas relative h-full w-full overflow-hidden select-none"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drawing.cancel();
        drag.current = null;
        setMarquee(null);
      }}
      onDoubleClick={onDoubleClick}
    >
      <input
        id={CANVAS_IMAGE_INPUT_ID}
        ref={imageImport.fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) void imageImport.addFiles(event.target.files);
          event.target.value = '';
        }}
      />
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

      <CanvasImageLayer />

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

      <CanvasAnnotationLayer draft={drawing.draft} />

      {/* Marquee */}
      {marquee && (
        <div
          className="pointer-events-none absolute rounded-[3px] border border-droid-accent/70 bg-droid-accent/10"
          style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }}
        />
      )}

      {frames.length === 0 && studio.annotations.length === 0 && studio.images.length === 0 && (
        <CanvasEmptyState onAddFrame={requestAddFrame} onAddImage={imageImport.requestFilePicker} />
      )}

      <AnnotationToolbar />

      <CanvasControls
        getSize={() => {
          const r = rootRef.current?.getBoundingClientRect();
          return r ? { width: r.width, height: r.height } : null;
        }}
        onRequestAddFrame={requestAddFrame}
        onRequestAddImage={imageImport.requestFilePicker}
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

function isInteractiveCanvasTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, a, input, textarea, select, [role="button"]') !== null
  );
}
