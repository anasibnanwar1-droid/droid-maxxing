// Infinite-canvas transform math. The canvas has a single "view" (pan + zoom)
// and every frame lives in world coordinates. Screen space is what the user
// sees; world space is where frames are anchored. Keeping these two conversions
// in one place is what makes pan, zoom-to-cursor, marquee, and hit-testing all
// agree with each other.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasView {
  pan: Point; // screen-space translation applied after scaling
  zoom: number; // world→screen scale factor
}

const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;

export const DEFAULT_VIEW: CanvasView = { pan: { x: 0, y: 0 }, zoom: 1 };

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** World point → on-screen pixel (relative to the canvas viewport origin). */
export function worldToScreen(p: Point, view: CanvasView): Point {
  return { x: p.x * view.zoom + view.pan.x, y: p.y * view.zoom + view.pan.y };
}

/** On-screen pixel (relative to canvas viewport) → world point. */
export function screenToWorld(p: Point, view: CanvasView): Point {
  return { x: (p.x - view.pan.x) / view.zoom, y: (p.y - view.pan.y) / view.zoom };
}

/**
 * Zoom by `factor` while keeping the world point under `anchor` (a screen-space
 * pixel) pinned in place — the "zoom toward the cursor" behavior every real
 * canvas has. Returns the next view.
 */
export function zoomAtPoint(view: CanvasView, factor: number, anchor: Point): CanvasView {
  const nextZoom = clampZoom(view.zoom * factor);
  if (nextZoom === view.zoom) return view;
  const world = screenToWorld(anchor, view);
  return {
    zoom: nextZoom,
    pan: { x: anchor.x - world.x * nextZoom, y: anchor.y - world.y * nextZoom },
  };
}

/** Set an absolute zoom level, keeping `anchor` pinned. */
export function setZoomAtPoint(view: CanvasView, nextZoomRaw: number, anchor: Point): CanvasView {
  const nextZoom = clampZoom(nextZoomRaw);
  const world = screenToWorld(anchor, view);
  return {
    zoom: nextZoom,
    pan: { x: anchor.x - world.x * nextZoom, y: anchor.y - world.y * nextZoom },
  };
}

/** Translate the view by a screen-space delta (panning). */
export function panBy(view: CanvasView, dx: number, dy: number): CanvasView {
  return { ...view, pan: { x: view.pan.x + dx, y: view.pan.y + dy } };
}

/**
 * Compute a view that fits the given world rects into `viewport` with padding,
 * centered. Used by "zoom to fit" and the initial framing when frames are added.
 */
export function fitRects(
  rects: Rect[],
  viewport: { width: number; height: number },
  padding = 96,
  maxZoom = 1,
): CanvasView {
  if (rects.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { ...DEFAULT_VIEW };
  }
  const bounds = boundingRect(rects);
  const availW = Math.max(1, viewport.width - padding * 2);
  const availH = Math.max(1, viewport.height - padding * 2);
  const zoom = clampZoom(Math.min(availW / bounds.width, availH / bounds.height, maxZoom));
  const worldCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  return {
    zoom,
    pan: {
      x: viewport.width / 2 - worldCenter.x * zoom,
      y: viewport.height / 2 - worldCenter.y * zoom,
    },
  };
}

/**
 * Pick the readable portion of a frame to focus. Tall generated documents are
 * canvas artifacts, not thumbnails: fitting their full height makes the first
 * screen illegible. Focus their top viewport while ordinary app frames remain
 * fully visible.
 */
export function readableFrameRect(
  rect: Rect,
  viewport: { width: number; height: number },
  padding = 96,
): Rect {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const readableHeight = rect.width * (availableHeight / availableWidth);
  if (rect.height <= readableHeight * 1.35) return rect;
  return { ...rect, height: Math.min(rect.height, readableHeight) };
}

function boundingRect(rects: Rect[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Axis-aligned rect intersection test (world space), used by marquee select. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Normalize a two-point drag into a positive-size rect. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}
