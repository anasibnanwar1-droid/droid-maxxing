import { ImagePlus, Maximize2, Minus, Plus } from 'lucide-react';
import { useStudioCanvas, sizeOf } from './StudioCanvasContext';
import { fitRects, setZoomAtPoint, type Rect, type CanvasView } from './studioCanvasMath';
import { MAX_ZOOM } from './studioCanvasMath';

/**
 * Bottom-right canvas HUD: zoom readout + in/out + zoom-to-fit. Zoom actions are
 * anchored at the viewport center so the framing stays stable.
 */
export default function CanvasControls({
  getSize,
  onRequestAddFrame,
  onRequestAddImage,
}: {
  getSize: () => { width: number; height: number } | null;
  onRequestAddFrame: () => void;
  onRequestAddImage: () => void;
}) {
  const { studio, studioDispatch } = useStudioCanvas();
  const { view, frames, images } = studio;

  const setView = (v: CanvasView) => {
    studioDispatch({ type: 'SET_VIEW', view: v });
  };

  const zoomStep = (factor: number) => {
    const size = getSize();
    if (!size) return;
    const anchor = { x: size.width / 2, y: size.height / 2 };
    setView(setZoomAtPoint(view, view.zoom * factor, anchor));
  };

  const fit = () => {
    const size = getSize();
    if (!size) return;
    if (frames.length === 0 && images.length === 0) {
      setView({ pan: { x: size.width / 2, y: size.height / 2 }, zoom: 1 });
      return;
    }
    const rects: Rect[] = [
      ...frames.map((f) => {
        const s = sizeOf(f);
        return { x: f.x, y: f.y, width: s.width, height: s.height };
      }),
      ...images.map((image) => ({
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
      })),
    ];
    setView(fitRects(rects, size, 120, MAX_ZOOM));
  };

  return (
    <div className="studio-floating-surface pointer-events-auto absolute bottom-4 right-4 flex items-center rounded-xl p-1">
      <button
        onClick={onRequestAddFrame}
        className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-droid-text-secondary transition-colors hover:bg-droid-active/70 hover:text-droid-text"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
        Add page
      </button>
      <button
        onClick={onRequestAddImage}
        className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11.5px] text-droid-text-secondary transition-colors hover:bg-droid-active/70 hover:text-droid-text"
      >
        <ImagePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
        Add image
      </button>
      <div className="mx-1 h-4 w-px bg-droid-border" />
      <div className="flex items-center gap-0.5">
        <HudButton
          label="Zoom out"
          onClick={() => {
            zoomStep(0.8);
          }}
        >
          <Minus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </HudButton>
        <button
          onClick={() => {
            zoomStep(1 / view.zoom);
          }}
          className="min-w-[48px] rounded-lg px-2 py-1 text-center text-[11px] tabular-nums text-droid-text-secondary transition-colors hover:bg-droid-active/70 hover:text-droid-text"
          title="Reset to 100%"
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <HudButton
          label="Zoom in"
          onClick={() => {
            zoomStep(1.25);
          }}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </HudButton>
        <div className="mx-0.5 h-4 w-px bg-droid-border" />
        <HudButton label="Fit all pages" onClick={fit}>
          <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.75} />
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
      className="group relative flex h-7 w-7 items-center justify-center rounded-lg text-droid-text-secondary transition-colors hover:bg-droid-active/70 hover:text-droid-text"
    >
      {children}
      <span className="pointer-events-none absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-lg border border-droid-border bg-droid-elevated px-2 py-1 text-[10.5px] font-normal text-droid-text opacity-0 shadow-lg transition-opacity delay-200 duration-150 group-hover:opacity-100">
        {label}
      </span>
    </button>
  );
}
