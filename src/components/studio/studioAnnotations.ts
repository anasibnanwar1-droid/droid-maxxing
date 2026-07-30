import { sizeOf, type StudioAnnotation, type StudioFrame } from './StudioCanvasContext';
import { worldToScreen, type CanvasView, type Point, type Rect } from './studioCanvasMath';

export const ANNOTATION_COLORS: Record<StudioAnnotation['color'], string> = {
  blue: '#3b82f6',
  red: '#ef4444',
  green: '#22c55e',
  amber: '#f59e0b',
};

export function snapLineEnd(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return end;
  const angle = Math.atan2(dy, dx);
  const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: start.x + Math.cos(snappedAngle) * distance,
    y: start.y + Math.sin(snappedAngle) * distance,
  };
}

export function squareEnd(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: start.x + (dx < 0 ? -side : side),
    y: start.y + (dy < 0 ? -side : side),
  };
}

export function annotationPointToWorld(
  annotation: Pick<StudioAnnotation, 'frameId'>,
  point: Point,
  frames: StudioFrame[],
): Point {
  if (!annotation.frameId) return point;
  const frame = frames.find((candidate) => candidate.id === annotation.frameId);
  return frame ? { x: frame.x + point.x, y: frame.y + point.y } : point;
}

export function worldPointToAnnotation(
  annotation: Pick<StudioAnnotation, 'frameId'>,
  point: Point,
  frames: StudioFrame[],
): Point {
  if (!annotation.frameId) return point;
  const frame = frames.find((candidate) => candidate.id === annotation.frameId);
  return frame ? { x: point.x - frame.x, y: point.y - frame.y } : point;
}

export function topFrameAtPoint(frames: StudioFrame[], point: Point): StudioFrame | undefined {
  return [...frames].reverse().find((frame) => {
    const size = sizeOf(frame);
    return (
      point.x >= frame.x &&
      point.x <= frame.x + size.width &&
      point.y >= frame.y &&
      point.y <= frame.y + size.height
    );
  });
}

export function measureDistance(annotation: StudioAnnotation): number {
  if (annotation.points.length < 2) return 0;
  const [start, end] = annotation.points;
  return Math.hypot(end.x - start.x, end.y - start.y);
}

export function annotationRect(annotation: StudioAnnotation): Rect | null {
  if (annotation.points.length < 2) return null;
  const [start, end] = annotation.points;
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function isMeaningfulAnnotation(annotation: StudioAnnotation): boolean {
  if (annotation.kind === 'pencil') {
    if (annotation.points.length < 2) return false;
    const first = annotation.points[0];
    return annotation.points.some((point) => Math.hypot(point.x - first.x, point.y - first.y) >= 3);
  }
  return measureDistance(annotation) >= 3;
}

export type AnnotationResizeHandle =
  | 'start'
  | 'end'
  | 'n'
  | 'e'
  | 's'
  | 'w'
  | 'nw'
  | 'ne'
  | 'se'
  | 'sw';

export function annotationScreenPoints(
  annotation: StudioAnnotation,
  frames: StudioFrame[],
  view: CanvasView,
): Point[] {
  return annotation.points.map((point) =>
    worldToScreen(annotationPointToWorld(annotation, point, frames), view),
  );
}

export function annotationScreenBounds(
  annotation: StudioAnnotation,
  frames: StudioFrame[],
  view: CanvasView,
): Rect | null {
  const points = annotationScreenPoints(annotation, frames, view);
  if (points.length === 0) return null;
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function hitTestAnnotation(
  annotation: StudioAnnotation,
  point: Point,
  frames: StudioFrame[],
  view: CanvasView,
  tolerance = 8,
): boolean {
  const points = annotationScreenPoints(annotation, frames, view);
  if (points.length < 2) return false;
  if (
    annotation.kind === 'rectangle' ||
    annotation.kind === 'square' ||
    annotation.kind === 'ellipse'
  ) {
    const bounds = annotationScreenBounds(annotation, frames, view);
    if (!bounds) return false;
    return (
      point.x >= bounds.x - tolerance &&
      point.x <= bounds.x + bounds.width + tolerance &&
      point.y >= bounds.y - tolerance &&
      point.y <= bounds.y + bounds.height + tolerance
    );
  }
  return points.some((candidate, index) => {
    if (index === 0) return false;
    return distanceToSegment(point, points[index - 1], candidate) <= tolerance;
  });
}

export function hitResizeHandle(
  annotation: StudioAnnotation,
  point: Point,
  frames: StudioFrame[],
  view: CanvasView,
): AnnotationResizeHandle | null {
  const handles = annotationHandles(annotation, frames, view);
  for (const [name, handle] of handles) {
    if (Math.hypot(point.x - handle.x, point.y - handle.y) <= 9) return name;
  }
  return null;
}

export function annotationHandles(
  annotation: StudioAnnotation,
  frames: StudioFrame[],
  view: CanvasView,
): [AnnotationResizeHandle, Point][] {
  if (annotation.kind === 'pencil') return [];
  const points = annotationScreenPoints(annotation, frames, view);
  if (points.length < 2) return [];
  if (annotation.kind === 'line' || annotation.kind === 'arrow' || annotation.kind === 'measure') {
    return [
      ['start', points[0]],
      ['end', points[1]],
    ];
  }
  const bounds = annotationScreenBounds(annotation, frames, view);
  if (!bounds) return [];
  const corners: [AnnotationResizeHandle, Point][] = [
    ['nw', { x: bounds.x, y: bounds.y }],
    ['ne', { x: bounds.x + bounds.width, y: bounds.y }],
    ['se', { x: bounds.x + bounds.width, y: bounds.y + bounds.height }],
    ['sw', { x: bounds.x, y: bounds.y + bounds.height }],
  ];
  if (annotation.kind === 'square') return corners;
  return [
    ...corners,
    ['n', { x: bounds.x + bounds.width / 2, y: bounds.y }],
    ['e', { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 }],
    ['s', { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height }],
    ['w', { x: bounds.x, y: bounds.y + bounds.height / 2 }],
  ];
}

export function moveAnnotation(
  annotation: StudioAnnotation,
  dx: number,
  dy: number,
): StudioAnnotation {
  return {
    ...annotation,
    points: annotation.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
  };
}

export function resizeAnnotation(
  annotation: StudioAnnotation,
  handle: AnnotationResizeHandle,
  point: Point,
): StudioAnnotation {
  if (annotation.points.length < 2 || annotation.kind === 'pencil') return annotation;
  if (handle === 'start' || handle === 'end') {
    const index = handle === 'start' ? 0 : 1;
    return {
      ...annotation,
      points: annotation.points.map((candidate, candidateIndex) =>
        candidateIndex === index ? point : candidate,
      ),
    };
  }

  const rect = annotationRect(annotation);
  if (!rect) return annotation;
  if (handle === 'n' || handle === 'e' || handle === 's' || handle === 'w') {
    const left = handle === 'w' ? point.x : rect.x;
    const right = handle === 'e' ? point.x : rect.x + rect.width;
    const top = handle === 'n' ? point.y : rect.y;
    const bottom = handle === 's' ? point.y : rect.y + rect.height;
    return {
      ...annotation,
      points: [
        { x: left, y: top },
        { x: right, y: bottom },
      ],
    };
  }
  const opposite = {
    nw: { x: rect.x + rect.width, y: rect.y + rect.height },
    ne: { x: rect.x, y: rect.y + rect.height },
    se: { x: rect.x, y: rect.y },
    sw: { x: rect.x + rect.width, y: rect.y },
  }[handle];
  const resizedPoint = annotation.kind === 'square' ? squareEnd(opposite, point) : point;
  return { ...annotation, points: [opposite, resizedPoint] };
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}
