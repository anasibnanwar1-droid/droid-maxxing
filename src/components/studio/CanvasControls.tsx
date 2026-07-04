import { Maximize2, Minus, Plus } from 'lucide-react';
import { useStudioCanvas, sizeOf } from './StudioCanvasContext';
import {
  fitRects,
  setZoomAtPoint,
  type Rect,
  type CanvasView,
} from './studioCanvasMath';

/**
 * Bottom-right canvas HUD: zoom readout + in/out + zoom-to-fit. Zoom actions are
 * anchored at the viewport center so the framing stays stable.
 */
export default function CanvasControls({
  getSize,
  onRequestAddFrame,
}: {
  getSize: () => { width: number; height: number } | null;
  onRequestAddFrame: () => void;
}) {
  const { studio, studioDispatch } = useStudioCanvas();
  const { view, frames } = studio;

  const setView = (v: CanvasView) => { studioDispatch({ type: 'SET_VIEW', view: v }); };

  const zoomStep = (factor: number) => {
    const size = getSize();
    if (!size) return;
    const anchor = { x: size.width / 2, y: size.height / 2 };
    setView(setZoomAtPoint(view, view.zoom * factor, anchor));
  };

  const fit = () => {
    const size = getSize();
    if (!size) return;
    if (frames.length === 0) {
      setView({ pan: { x: size.width / 2, y: size.height / 2 }, zoom: 1 });
      return;
    }
    const rects: Rect[] = frames.map((f) => {
      const s = sizeOf(f);
      return { x: f.x, y: f.y, width: s.width, height: s.height };
    });
    setView(fitRects(rects, size, 120));
  };

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 flex items-center gap-2">
      <button
        onClick={onRequestAddFrame}
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-droid-border bg-droid-elevated/90 px-3 py-1.5 text-[12px] text-droid-text-secondary shadow-lg backdrop-blur transition-colors hover:border-[#ee6018]/50 hover:text-droid-text"
      >
        <Plus className="h-3.5 w-3.5" />
        Add frame
      </button>
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-droid-border bg-droid-elevated/90 p-0.5 shadow-lg backdrop-blur">
        <HudButton label="Zoom out" onClick={() => { zoomStep(0.8); }}>
          <Minus className="h-3.5 w-3.5" />
        </HudButton>
        <button
          onClick={() => { zoomStep(1 / view.zoom); }}
          className="min-w-[48px] rounded-full px-2 py-1 text-center font-mono text-[11.5px] text-droid-text-secondary transition-colors hover:text-droid-text"
          title="Reset to 100%"
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <HudButton label="Zoom in" onClick={() => { zoomStep(1.25); }}>
          <Plus className="h-3.5 w-3.5" />
        </HudButton>
        <div className="mx-0.5 h-4 w-px bg-white/10" />
        <HudButton label="Zoom to fit" onClick={fit}>
          <Maximize2 className="h-3.5 w-3.5" />
        </HudButton>
      </div>
    </div>
  );
}

function HudButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-full text-droid-text-secondary transition-colors hover:bg-white/10 hover:text-droid-text"
    >
      {children}
    </button>
  );
}
