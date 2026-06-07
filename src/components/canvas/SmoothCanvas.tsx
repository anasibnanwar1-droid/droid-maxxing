import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, PointerEvent, WheelEvent } from 'react';
import {
  canvasPointToContent,
  fitContent,
  isPointInsideRenderedContent,
  type CanvasFit,
  type Point,
  type Size,
} from './canvasMath';

interface SmoothCanvasProps {
  contentSize: Size;
  padding?: number;
  className?: string;
  contentClassName?: string;
  children: (fit: CanvasFit) => ReactNode;
  overlay?: (fit: CanvasFit) => ReactNode;
  onFitChange?: (fit: CanvasFit) => void;
  onContentPointerDown?: (point: Point, event: PointerEvent<HTMLDivElement>, fit: CanvasFit) => void;
  onContentPointerMove?: (point: Point, event: PointerEvent<HTMLDivElement>, fit: CanvasFit) => void;
  onContentPointerUp?: (point: Point, event: PointerEvent<HTMLDivElement>, fit: CanvasFit) => void;
  onContentPointerLeave?: (event: PointerEvent<HTMLDivElement>, fit: CanvasFit) => void;
  onContentWheel?: (point: Point, event: WheelEvent<HTMLDivElement>, fit: CanvasFit) => void;
}

const MIN_SIZE: Size = { width: 1, height: 1 };

export function SmoothCanvas({
  contentSize,
  padding = 24,
  className = '',
  contentClassName = '',
  children,
  overlay,
  onFitChange,
  onContentPointerDown,
  onContentPointerMove,
  onContentPointerUp,
  onContentPointerLeave,
  onContentWheel,
}: SmoothCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<Size>(MIN_SIZE);
  const fit = useMemo(() => fitContent(container, contentSize, padding), [container, contentSize, padding]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;

    const resize = () => {
      const rect = node.getBoundingClientRect();
      setContainer({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    onFitChange?.(fit);
  }, [fit, onFitChange]);

  const readPoint = (event: PointerEvent<HTMLDivElement> | WheelEvent<HTMLDivElement>): Point | null => {
    const node = rootRef.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const canvasPoint = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    if (!isPointInsideRenderedContent(canvasPoint, fit)) return null;
    return canvasPointToContent(canvasPoint, fit);
  };

  return (
    <div
      ref={rootRef}
      className={`relative min-h-0 min-w-0 overflow-hidden ${className}`}
      onPointerDown={(event) => {
        const point = readPoint(event);
        if (point) onContentPointerDown?.(point, event, fit);
      }}
      onPointerMove={(event) => {
        const point = readPoint(event);
        if (point) onContentPointerMove?.(point, event, fit);
        else onContentPointerLeave?.(event, fit);
      }}
      onPointerUp={(event) => {
        const point = readPoint(event);
        if (point) onContentPointerUp?.(point, event, fit);
      }}
      onPointerLeave={(event) => onContentPointerLeave?.(event, fit)}
      onWheel={(event) => {
        const point = readPoint(event);
        if (point) onContentWheel?.(point, event, fit);
      }}
    >
      <div
        className={`absolute left-0 top-0 overflow-hidden ${contentClassName}`}
        style={{
          width: fit.content.width,
          height: fit.content.height,
          transform: `translate3d(${fit.offset.x}px, ${fit.offset.y}px, 0) scale(${fit.scale})`,
          transformOrigin: 'top left',
        }}
      >
        {children(fit)}
      </div>
      {overlay?.(fit)}
    </div>
  );
}
