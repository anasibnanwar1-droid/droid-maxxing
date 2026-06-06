export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface CanvasFit {
  content: Size;
  container: Size;
  scale: number;
  rendered: Size;
  offset: Point;
}

export function fitContent(container: Size, content: Size, padding = 0): CanvasFit {
  const availableWidth = Math.max(0, container.width - padding * 2);
  const availableHeight = Math.max(0, container.height - padding * 2);
  const safeContent = {
    width: Math.max(1, content.width),
    height: Math.max(1, content.height),
  };
  const scale = Math.min(availableWidth / safeContent.width, availableHeight / safeContent.height);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const rendered = {
    width: Math.round(safeContent.width * safeScale),
    height: Math.round(safeContent.height * safeScale),
  };
  return {
    content: safeContent,
    container,
    scale: safeScale,
    rendered,
    offset: {
      x: Math.round((container.width - rendered.width) / 2),
      y: Math.round((container.height - rendered.height) / 2),
    },
  };
}

export function canvasPointToContent(point: Point, fit: CanvasFit): Point {
  return {
    x: Math.round((point.x - fit.offset.x) / fit.scale),
    y: Math.round((point.y - fit.offset.y) / fit.scale),
  };
}

export function contentPointToCanvas(point: Point, fit: CanvasFit): Point {
  return {
    x: Math.round(fit.offset.x + point.x * fit.scale),
    y: Math.round(fit.offset.y + point.y * fit.scale),
  };
}

export function isPointInsideRenderedContent(point: Point, fit: CanvasFit): boolean {
  return (
    point.x >= fit.offset.x &&
    point.y >= fit.offset.y &&
    point.x <= fit.offset.x + fit.rendered.width &&
    point.y <= fit.offset.y + fit.rendered.height
  );
}
