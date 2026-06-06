import { useRef, useState } from 'react';
import { SmoothCanvas } from '../canvas/SmoothCanvas';
import type { Point } from '../canvas/canvasMath';
import type { BrowserBox, BrowserElementRef, BrowserState, BrowserViewport } from '../../types/bridge';
import { DesignModeOverlay } from './DesignModeOverlay';

interface BrowserCanvasProps {
  browser?: BrowserState;
  viewport: BrowserViewport;
  designMode: boolean;
  sketchMode: boolean;
  selectedIds: string[];
  onScaleChange?: (scale: number) => void;
  onClickPoint: (point: Point) => void;
  onToggleElement: (ref: BrowserElementRef) => void;
  onAddRegion: (box: BrowserBox) => void;
  onScroll: (direction: 'up' | 'down' | 'left' | 'right', pixels: number) => void;
}

export function BrowserCanvas({
  browser,
  viewport,
  designMode,
  sketchMode,
  selectedIds,
  onScaleChange,
  onClickPoint,
  onToggleElement,
  onAddRegion,
  onScroll,
}: BrowserCanvasProps) {
  const dragStart = useRef<Point | null>(null);
  const lastWheelAt = useRef(0);
  const [draftRegion, setDraftRegion] = useState<BrowserBox | null>(null);
  const contentSize = browser?.viewport ?? viewport;

  return (
    <SmoothCanvas
      contentSize={contentSize}
      padding={32}
      className="flex-1 bg-[#070707]"
      contentClassName="rounded-[6px] bg-[#0d0d0d] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_24px_80px_rgba(0,0,0,0.55)]"
      onFitChange={(fit) => onScaleChange?.(fit.scale)}
      onContentPointerDown={(point, event) => {
        if (!browser) return;
        if (designMode && sketchMode) {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragStart.current = point;
          setDraftRegion({ x: point.x, y: point.y, width: 0, height: 0 });
          return;
        }
        if (designMode) {
          const ref = findSmallestRefAtPoint(browser.refs, point);
          if (ref) onToggleElement(ref);
          return;
        }
        onClickPoint(point);
      }}
      onContentPointerMove={(point) => {
        if (!dragStart.current) return;
        setDraftRegion(normalizeBox(dragStart.current, point, contentSize.width, contentSize.height));
      }}
      onContentPointerUp={(point, event) => {
        if (!dragStart.current) return;
        const box = normalizeBox(dragStart.current, point, contentSize.width, contentSize.height);
        dragStart.current = null;
        setDraftRegion(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (box.width >= 8 && box.height >= 8) onAddRegion(box);
      }}
      onContentWheel={(_, event) => {
        if (!browser) return;
        event.preventDefault();
        const now = Date.now();
        if (now - lastWheelAt.current < 140) return;
        lastWheelAt.current = now;
        const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
        const direction = horizontal
          ? event.deltaX > 0 ? 'right' : 'left'
          : event.deltaY > 0 ? 'down' : 'up';
        const pixels = Math.min(900, Math.max(120, Math.round(horizontal ? Math.abs(event.deltaX) : Math.abs(event.deltaY))));
        onScroll(direction, pixels);
      }}
    >
      {() => (
        <div className="relative h-full w-full overflow-hidden rounded-[6px] bg-[#0b0b0b]">
          {browser?.screenshotUrl ? (
            <img
              src={browser.screenshotUrl}
              alt={browser.title || browser.url}
              draggable={false}
              className="h-full w-full select-none object-fill"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[#0b0b0b]">
              <div className="font-mono text-[42px] tracking-[0.18em] text-droid-text-muted/35">DROID</div>
            </div>
          )}
          <DesignModeOverlay
            refs={browser?.refs ?? []}
            selectedIds={selectedIds}
            active={designMode}
            draftRegion={draftRegion}
            agentCursor={browser?.agentCursor}
          />
        </div>
      )}
    </SmoothCanvas>
  );
}

function findSmallestRefAtPoint(refs: BrowserElementRef[], point: Point): BrowserElementRef | undefined {
  return refs
    .filter((ref) =>
      point.x >= ref.box.x &&
      point.y >= ref.box.y &&
      point.x <= ref.box.x + ref.box.width &&
      point.y <= ref.box.y + ref.box.height)
    .sort((a, b) => area(a.box) - area(b.box))[0];
}

function normalizeBox(start: Point, end: Point, maxWidth: number, maxHeight: number): BrowserBox {
  const x1 = clamp(Math.min(start.x, end.x), 0, maxWidth);
  const y1 = clamp(Math.min(start.y, end.y), 0, maxHeight);
  const x2 = clamp(Math.max(start.x, end.x), 0, maxWidth);
  const y2 = clamp(Math.max(start.y, end.y), 0, maxHeight);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function area(box: BrowserBox): number {
  return box.width * box.height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
