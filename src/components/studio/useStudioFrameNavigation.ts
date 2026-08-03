import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { fitRects, readableFrameRect, type CanvasView } from './studioCanvasMath';
import {
  sizeOf,
  useStudioCanvas,
  type StudioCanvasState,
  type StudioFrame,
} from './StudioCanvasContext';

const FOCUS_DURATION_MS = 420;

/** Owns animated frame focus and restore-aware entrance behavior for the canvas. */
export function useStudioFrameNavigation(rootRef: RefObject<HTMLDivElement | null>) {
  const { studio, studioDispatch } = useStudioCanvas();
  const { frames, view } = studio;
  const viewRef = useRef(view);
  viewRef.current = view;
  const animationFrame = useRef<number | null>(null);
  const previousFrameCount = useRef(frames.length);
  const hydrateSeen = useRef(studio.hydrateCount);
  const handledFocusRequest = useRef<StudioFrameFocusRequest | null>(null);
  const restoring = studio.hydrateCount !== hydrateSeen.current;

  const stopAnimation = useCallback(() => {
    if (animationFrame.current) cancelAnimationFrame(animationFrame.current);
    animationFrame.current = null;
  }, []);

  const animateView = useCallback(
    (target: CanvasView) => {
      stopAnimation();
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        studioDispatch({ type: 'SET_VIEW', view: target });
        return;
      }
      const start = viewRef.current;
      const startedAt = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / FOCUS_DURATION_MS);
        const eased = 1 - Math.pow(1 - progress, 4);
        studioDispatch({
          type: 'SET_VIEW',
          view: {
            zoom: start.zoom + (target.zoom - start.zoom) * eased,
            pan: {
              x: start.pan.x + (target.pan.x - start.pan.x) * eased,
              y: start.pan.y + (target.pan.y - start.pan.y) * eased,
            },
          },
        });
        if (progress < 1) animationFrame.current = requestAnimationFrame(step);
        else animationFrame.current = null;
      };
      animationFrame.current = requestAnimationFrame(step);
    },
    [stopAnimation, studioDispatch],
  );

  const focusFrame = useCallback(
    (frame: StudioFrame) => {
      const bounds = rootRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const viewport = { width: bounds.width, height: bounds.height };
      const size = sizeOf(frame);
      const frameRect = { x: frame.x, y: frame.y, width: size.width, height: size.height };
      const focusRect =
        frame.kind === 'showcase' ? readableFrameRect(frameRect, viewport, 96) : frameRect;
      animateView(fitRects([focusRect], viewport, 96));
    },
    [animateView, rootRef],
  );

  const interactWithFrame = useCallback(
    (frame: StudioFrame) => {
      studioDispatch({ type: 'SET_INTERACTING', id: frame.id });
    },
    [studioDispatch],
  );

  useEffect(() => {
    const request = studio.focusFrameRequest;
    if (!request || request === handledFocusRequest.current) return;
    handledFocusRequest.current = request;
    const frame = frames.find((candidate) => candidate.id === request.id);
    if (frame) focusFrame(frame);
  }, [focusFrame, frames, studio.focusFrameRequest]);

  useEffect(() => {
    const hydrated = studio.hydrateCount !== hydrateSeen.current;
    hydrateSeen.current = studio.hydrateCount;
    if (!hydrated && frames.length > previousFrameCount.current) {
      focusFrame(frames[frames.length - 1]);
    }
    previousFrameCount.current = frames.length;
  }, [focusFrame, frames, studio.hydrateCount]);

  useEffect(() => stopAnimation, [stopAnimation]);

  return { interactWithFrame, restoring, stopAnimation, viewRef };
}

type StudioFrameFocusRequest = NonNullable<StudioCanvasState['focusFrameRequest']>;
