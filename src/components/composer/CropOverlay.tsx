import { useRef } from 'react';
import { MIN_CROP_SIDE, type CropRect } from '../../lib/images';

/**
 * Pointer-drag crop layer. Renders on top of the displayed image (which the
 * parent sizes) and reports rects in that container's pixel coordinates; the
 * parent converts to natural pixels on apply. The dimmed surround is a single
 * oversized box-shadow on the selection div.
 */
export function CropOverlay({
  rect,
  onChange,
}: {
  rect: CropRect | null;
  onChange: (rect: CropRect | null) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);

  const pointFrom = (e: React.PointerEvent) => {
    const el = layerRef.current;
    if (!el) return { x: 0, y: 0 };
    const bounds = el.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - bounds.left, 0), bounds.width),
      y: Math.min(Math.max(e.clientY - bounds.top, 0), bounds.height),
    };
  };

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = pointFrom(e);
        originRef.current = p;
        onChange({ x: p.x, y: p.y, width: 0, height: 0 });
      }}
      onPointerMove={(e) => {
        const origin = originRef.current;
        if (!origin) return;
        const p = pointFrom(e);
        onChange({
          x: Math.min(origin.x, p.x),
          y: Math.min(origin.y, p.y),
          width: Math.abs(p.x - origin.x),
          height: Math.abs(p.y - origin.y),
        });
      }}
      onPointerUp={() => {
        originRef.current = null;
        // A tap (near-zero drag) clears the selection instead of cropping.
        if (rect && rect.width < MIN_CROP_SIDE && rect.height < MIN_CROP_SIDE) onChange(null);
      }}
    >
      {rect && rect.width > 0 && rect.height > 0 && (
        <div
          className="absolute rounded-[2px] border border-droid-accent"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
          }}
        />
      )}
    </div>
  );
}
