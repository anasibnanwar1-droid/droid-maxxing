import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { pushEscapeLayer } from '../environment/usePopover';
import { useStudioCanvas, type StudioAnnotation } from './StudioCanvasContext';
import { screenToWorld, type Point } from './studioCanvasMath';
import {
  annotationScreenGeometry,
  hitResizeHandleGeometry,
  hitTestAnnotationGeometry,
  isMeaningfulAnnotation,
  moveAnnotation,
  resizeAnnotation,
  snapLineEnd,
  squareEnd,
  topFrameAtPoint,
  worldPointToAnnotation,
  type AnnotationResizeHandle,
} from './studioAnnotations';

function annotationId(): string {
  try {
    return `note_${crypto.randomUUID().slice(0, 8)}`;
  } catch {
    return `note_${Date.now().toString(36)}`;
  }
}

function localToAnchor(point: Point, frame: ReturnType<typeof topFrameAtPoint>): Point {
  return frame ? { x: point.x - frame.x, y: point.y - frame.y } : point;
}

interface EditGesture {
  id: string;
  mode: 'move' | 'resize';
  handle?: AnnotationResizeHandle;
  start: Point;
  original: StudioAnnotation;
}

export function useCanvasDrawing(rootRef: RefObject<HTMLDivElement | null>) {
  const { studio, studioDispatch } = useStudioCanvas();
  const [draft, setDraft] = useState<StudioAnnotation | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const draftRef = useRef<StudioAnnotation | null>(null);
  const editRef = useRef<EditGesture | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const escapeCleanupRef = useRef<(() => void) | null>(null);
  const hoverPointRef = useRef<Point | null>(null);
  const hoverFrameRef = useRef<number | null>(null);
  const annotationTargets = useMemo(
    () =>
      studio.annotations
        .map((annotation) => ({
          annotation,
          geometry: annotationScreenGeometry(annotation, studio.frames, studio.view),
        }))
        .reverse(),
    [studio.annotations, studio.frames, studio.view],
  );
  const hoverStateRef = useRef({
    targets: annotationTargets,
    selectedAnnotationId: studio.selectedAnnotationId,
  });
  hoverStateRef.current = {
    targets: annotationTargets,
    selectedAnnotationId: studio.selectedAnnotationId,
  };

  const screenFromEvent = (event: ReactPointerEvent): Point => {
    const rect = rootRef.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  };

  const worldFromEvent = (event: ReactPointerEvent): Point =>
    screenToWorld(screenFromEvent(event), studio.view);

  const capture = (event: ReactPointerEvent) => {
    pointerIdRef.current = event.pointerId;
    rootRef.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const cancel = useCallback(() => {
    const edit = editRef.current;
    if (edit) {
      studioDispatch({ type: 'UPDATE_ANNOTATION', id: edit.id, annotation: edit.original });
    }
    draftRef.current = null;
    editRef.current = null;
    setDraft(null);
    setCursor(null);
    escapeCleanupRef.current?.();
    escapeCleanupRef.current = null;
    const pointerId = pointerIdRef.current;
    if (pointerId !== null && rootRef.current?.hasPointerCapture(pointerId)) {
      rootRef.current.releasePointerCapture(pointerId);
    }
    pointerIdRef.current = null;
  }, [rootRef, studioDispatch]);

  const beginDrawing = (event: ReactPointerEvent): boolean => {
    if (studio.tool !== 'draw' || event.button !== 0) return false;
    const world = worldFromEvent(event);
    const frame = topFrameAtPoint(studio.frames, world);
    const point = localToAnchor(world, frame);
    const next: StudioAnnotation = {
      id: annotationId(),
      kind: studio.drawingStyle.kind,
      points: [point],
      color: studio.drawingStyle.color,
      fill: studio.drawingStyle.fill,
      strokeWidth: studio.drawingStyle.strokeWidth,
      frameId: frame?.id,
    };
    draftRef.current = next;
    setDraft(next);
    escapeCleanupRef.current?.();
    escapeCleanupRef.current = pushEscapeLayer(cancel);
    studioDispatch({ type: 'SET_INTERACTING', id: null });
    capture(event);
    return true;
  };

  const beginEdit = (event: ReactPointerEvent): boolean => {
    if (studio.tool !== 'select' || event.button !== 0) return false;
    const screen = screenFromEvent(event);
    const selected = annotationTargets.find(
      ({ annotation }) => annotation.id === studio.selectedAnnotationId,
    );
    const handle = selected
      ? hitResizeHandleGeometry(selected.annotation, screen, selected.geometry)
      : null;
    const target =
      selected && handle
        ? selected
        : annotationTargets.find(({ annotation, geometry }) =>
            hitTestAnnotationGeometry(annotation, screen, geometry),
          );
    if (!target) {
      studioDispatch({ type: 'SELECT_ANNOTATION', id: null });
      return false;
    }
    const { annotation } = target;
    const start = worldPointToAnnotation(annotation, worldFromEvent(event), studio.frames);
    editRef.current = {
      id: annotation.id,
      mode: handle ? 'resize' : 'move',
      handle: handle ?? undefined,
      start,
      original: annotation,
    };
    setCursor(handle ? cursorForHandle(handle) : 'move');
    escapeCleanupRef.current?.();
    escapeCleanupRef.current = pushEscapeLayer(cancel);
    studioDispatch({ type: 'SELECT_ANNOTATION', id: annotation.id });
    studioDispatch({ type: 'SELECT_FRAMES', ids: [] });
    capture(event);
    return true;
  };

  const move = (event: ReactPointerEvent): boolean => {
    const current = draftRef.current;
    if (current) {
      const frame = current.frameId
        ? studio.frames.find((candidate) => candidate.id === current.frameId)
        : undefined;
      let point = localToAnchor(worldFromEvent(event), frame);
      const start = current.points[0];
      if (current.kind === 'line' || current.kind === 'arrow' || current.kind === 'measure') {
        if (event.shiftKey) point = snapLineEnd(start, point);
      } else if (
        current.kind === 'square' ||
        ((current.kind === 'rectangle' || current.kind === 'ellipse') && event.shiftKey)
      ) {
        point = squareEnd(start, point);
      }
      const points =
        current.kind === 'pencil'
          ? appendPencilPoint(current.points, point, studio.view.zoom)
          : [start, point];
      const next = { ...current, points };
      draftRef.current = next;
      setDraft(next);
      return true;
    }

    const edit = editRef.current;
    if (!edit) return false;
    const point = worldPointToAnnotation(edit.original, worldFromEvent(event), studio.frames);
    const annotation =
      edit.mode === 'move'
        ? moveAnnotation(edit.original, point.x - edit.start.x, point.y - edit.start.y)
        : resizeAnnotation(edit.original, edit.handle ?? 'end', point);
    setCursor(edit.mode === 'move' ? 'move' : cursorForHandle(edit.handle ?? 'end'));
    studioDispatch({ type: 'UPDATE_ANNOTATION', id: edit.id, annotation });
    return true;
  };

  const finish = (event: ReactPointerEvent): boolean => {
    const current = draftRef.current;
    const edit = editRef.current;
    if (!current && !edit) return false;
    if (current) {
      draftRef.current = null;
      setDraft(null);
      if (isMeaningfulAnnotation(current)) {
        studioDispatch({ type: 'ADD_ANNOTATION', annotation: current });
      }
    }
    if (edit) {
      editRef.current = null;
    }
    escapeCleanupRef.current?.();
    escapeCleanupRef.current = null;
    releaseCapture(event.pointerId);
    return true;
  };

  const releaseCapture = (pointerId: number) => {
    if (rootRef.current?.hasPointerCapture(pointerId)) {
      rootRef.current.releasePointerCapture(pointerId);
    }
    pointerIdRef.current = null;
  };

  const updateHover = (event: ReactPointerEvent) => {
    if (studio.tool !== 'select') {
      if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current);
      hoverFrameRef.current = null;
      hoverPointRef.current = null;
      setCursor((current) => (current === null ? current : null));
      return;
    }
    hoverPointRef.current = screenFromEvent(event);
    if (hoverFrameRef.current !== null) return;
    hoverFrameRef.current = requestAnimationFrame(() => {
      hoverFrameRef.current = null;
      const point = hoverPointRef.current;
      if (!point) return;
      const { targets, selectedAnnotationId } = hoverStateRef.current;
      const selected = targets.find(({ annotation }) => annotation.id === selectedAnnotationId);
      const handle = selected
        ? hitResizeHandleGeometry(selected.annotation, point, selected.geometry)
        : null;
      const overAnnotation =
        handle !== null ||
        targets.some(({ annotation, geometry }) =>
          hitTestAnnotationGeometry(annotation, point, geometry),
        );
      const next = handle ? cursorForHandle(handle) : overAnnotation ? 'move' : null;
      setCursor((current) => (current === next ? current : next));
    });
  };

  useEffect(
    () => () => {
      escapeCleanupRef.current?.();
      if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current);
    },
    [],
  );

  return {
    draft,
    cursor: studio.tool === 'select' ? cursor : null,
    beginDrawing,
    beginEdit,
    move,
    finish,
    cancel,
    updateHover,
  };
}

function appendPencilPoint(points: Point[], point: Point, zoom: number): Point[] {
  const previous = points.at(-1);
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 1.5 / zoom) {
    return points;
  }
  if (points.length >= 240) return points;
  return [...points, point];
}

function cursorForHandle(handle: AnnotationResizeHandle): string {
  if (handle === 'nw' || handle === 'se') return 'nwse-resize';
  if (handle === 'ne' || handle === 'sw') return 'nesw-resize';
  if (handle === 'n' || handle === 's') return 'ns-resize';
  if (handle === 'e' || handle === 'w') return 'ew-resize';
  return 'crosshair';
}
