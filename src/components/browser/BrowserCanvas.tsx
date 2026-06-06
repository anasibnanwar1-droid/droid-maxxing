import { useRef, useState } from 'react';
import { SmoothCanvas } from '../canvas/SmoothCanvas';
import { contentPointToCanvas } from '../canvas/canvasMath';
import type { CanvasFit, Point, Size } from '../canvas/canvasMath';
import type { BrowserBox, BrowserElementRef, BrowserState, BrowserViewport, DesignReference } from '../../types/bridge';
import { DesignModeOverlay } from './DesignModeOverlay';
import { DesignModeComposer } from './DesignModeComposer';

interface BrowserCanvasProps {
  browser?: BrowserState;
  viewport: BrowserViewport;
  designMode: boolean;
  sketchMode: boolean;
  references: DesignReference[];
  selectedIds: string[];
  instruction: string;
  canSend: boolean;
  disabledReason?: string;
  onScaleChange?: (scale: number) => void;
  onClickPoint: (point: Point) => void;
  onToggleElement: (ref: BrowserElementRef) => void;
  onAddRegion: (box: BrowserBox) => void;
  onScroll: (direction: 'up' | 'down' | 'left' | 'right', pixels: number) => void;
  onInstructionChange: (value: string) => void;
  onRemoveReference: (id: string) => void;
  onSend: () => void;
}

export function BrowserCanvas({
  browser,
  viewport,
  designMode,
  sketchMode,
  references,
  selectedIds,
  instruction,
  canSend,
  disabledReason,
  onScaleChange,
  onClickPoint,
  onToggleElement,
  onAddRegion,
  onScroll,
  onInstructionChange,
  onRemoveReference,
  onSend,
}: BrowserCanvasProps) {
  const dragStart = useRef<Point | null>(null);
  const lastWheelAt = useRef(0);
  const [draftRegion, setDraftRegion] = useState<BrowserBox | null>(null);
  const contentSize = browser?.viewport ?? viewport;

  return (
    <SmoothCanvas
      contentSize={contentSize}
      padding={32}
      className="h-full w-full bg-[#070707]"
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
      overlay={(fit) => {
        if (!designMode || references.length === 0) return null;
        return (
          <DesignModeComposer
            references={references}
            instruction={instruction}
            canSend={canSend}
            disabledReason={disabledReason}
            style={composerStyle(references, browser?.refs ?? [], contentSize, fit)}
            onInstructionChange={onInstructionChange}
            onRemoveReference={onRemoveReference}
            onSend={onSend}
          />
        );
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

function composerStyle(
  references: DesignReference[],
  refs: BrowserElementRef[],
  contentSize: Size,
  fit: CanvasFit,
): { left: number; top: number } {
  const box = unionBoxes(references.map((ref) => boxForReference(ref, refs)).filter((item): item is BrowserBox => Boolean(item))) ?? {
    x: 0,
    y: 0,
    width: contentSize.width,
    height: 1,
  };
  const composerWidth = Math.min(420, Math.max(280, fit.container.width - 24));
  const composerHeight = 112;
  const below = contentPointToCanvas({ x: box.x, y: box.y + box.height + 10 }, fit);
  const above = contentPointToCanvas({ x: box.x, y: box.y }, fit);
  const top = below.y + composerHeight <= fit.container.height - 12
    ? below.y
    : above.y - composerHeight - 10;
  return {
    left: clamp(below.x, 12, Math.max(12, fit.container.width - composerWidth - 12)),
    top: clamp(top, 12, Math.max(12, fit.container.height - composerHeight - 12)),
  };
}

function boxForReference(reference: DesignReference, refs: BrowserElementRef[]): BrowserBox | undefined {
  if (reference.kind === 'element') {
    return reference.element?.box ?? refs.find((ref) => ref.ref === reference.id)?.box;
  }
  if (reference.kind === 'region') return reference.box;
  if (reference.points?.length) {
    const xs = reference.points.map((point) => point.x);
    const ys = reference.points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  return undefined;
}

function unionBoxes(boxes: BrowserBox[]): BrowserBox | undefined {
  if (boxes.length === 0) return undefined;
  const x1 = Math.min(...boxes.map((box) => box.x));
  const y1 = Math.min(...boxes.map((box) => box.y));
  const x2 = Math.max(...boxes.map((box) => box.x + box.width));
  const y2 = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
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
