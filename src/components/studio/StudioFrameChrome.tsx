import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Copy, Monitor, Play, Smartphone, Tablet, Trash2, X } from 'lucide-react';
import type { BrowserViewportMode } from '../../types/bridge';
import {
  sizeOf,
  useStudioCanvas,
  type StudioFrame,
  type StudioTool,
} from './StudioCanvasContext';
import type { Rect } from './studioCanvasMath';

const STATUS_COLOR: Record<StudioFrame['status'], string> = {
  loading: '#8a8a8a',
  building: '#ee6018',
  ready: '#6a8a6a',
  failed: '#c0563a',
};

const VIEWPORT_CYCLE: BrowserViewportMode[] = ['desktop', 'laptop', 'tablet', 'mobile'];
const VIEWPORT_ICON: Partial<Record<BrowserViewportMode, typeof Monitor>> = {
  desktop: Monitor,
  laptop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
};

/**
 * Screen-space chrome for one frame: label, selection ring, toolbar, drag/select
 * hit area, and agent cursor. Kept out of the scaled world layer so text stays
 * crisp at every zoom level. `rect` is the frame's on-screen pixel box.
 */
export default function StudioFrameChrome({
  frame,
  rect,
  zoom,
  tool,
  selected,
  onDuplicate,
}: {
  frame: StudioFrame;
  rect: Rect;
  zoom: number;
  tool: StudioTool;
  selected: boolean;
  onDuplicate: (frame: StudioFrame) => void;
}) {
  const { studio, studioDispatch } = useStudioCanvas();
  const interacting = studio.interactingFrameId === frame.id;
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  // `zoom` is captured at drag-start so a mid-drag zoom can't skew the delta.
  const drag = useRef<{
    px: number;
    py: number;
    fx: number;
    fy: number;
    moved: boolean;
    zoom: number;
  } | null>(null);
  const size = sizeOf(frame);
  const active = selected || hovered;
  const ringColor = selected ? '#ee6018' : hovered ? 'rgba(255,255,255,0.22)' : 'transparent';

  const beginDrag = (e: ReactPointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, fx: frame.x, fy: frame.y, moved: false, zoom };
  };
  const onDragMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.px) / d.zoom;
    const dy = (e.clientY - d.py) / d.zoom;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) d.moved = true;
    studioDispatch({ type: 'MOVE_FRAME', id: frame.id, x: d.fx + dx, y: d.fy + dy });
  };
  const endDrag = (e: ReactPointerEvent, additive: boolean) => {
    const d = drag.current;
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (d && !d.moved) studioDispatch({ type: 'TOGGLE_FRAME', id: frame.id, additive });
  };

  const cycleViewport = () => {
    const idx = VIEWPORT_CYCLE.indexOf(frame.mode);
    const next = VIEWPORT_CYCLE[(idx + 1) % VIEWPORT_CYCLE.length];
    studioDispatch({ type: 'UPDATE_FRAME', id: frame.id, patch: { mode: next } });
  };

  const headerScaledOffset = 30; // px of screen space reserved above the frame

  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onMouseEnter={() => { setHovered(true); }}
      onMouseLeave={() => { setHovered(false); }}
    >
      {/* Selection / hover ring */}
      <div
        className="pointer-events-none absolute -inset-[1.5px] rounded-[11px] transition-colors duration-150"
        style={{
          boxShadow: interacting
            ? '0 0 0 2px #ee6018, 0 0 28px -2px rgba(238,96,24,0.6)'
            : frame.status === 'building'
              ? '0 0 0 1.5px #ee6018, 0 0 22px -2px rgba(238,96,24,0.55)'
              : `0 0 0 1.5px ${ringColor}`,
        }}
      />

      {/* Header label (crisp, above the frame) */}
      <div
        className="pointer-events-auto absolute left-0 flex items-center gap-2"
        style={{ top: -headerScaledOffset, height: headerScaledOffset - 8 }}
        onPointerDown={beginDrag}
        onPointerMove={onDragMove}
        onPointerUp={(e) => { endDrag(e, e.shiftKey); }}
      >
        <span
          className="h-[7px] w-[7px] shrink-0 rounded-full"
          style={{
            backgroundColor: STATUS_COLOR[frame.status],
            boxShadow: frame.status === 'building' ? '0 0 8px #ee6018' : undefined,
          }}
        />
        {editing ? (
          <input
            autoFocus
            defaultValue={frame.name}
            onBlur={(e) => {
              studioDispatch({
                type: 'UPDATE_FRAME',
                id: frame.id,
                patch: { name: e.target.value.trim() || frame.name },
              });
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="w-44 rounded-lg border border-droid-border bg-droid-surface px-2 py-1 text-[12.5px] text-droid-text outline-none transition-colors focus:border-[#ee6018]/60 focus:bg-droid-surface"
          />
        ) : (
          <button
            onDoubleClick={() => { setEditing(true); }}
            className={`max-w-[220px] cursor-grab truncate text-[12.5px] font-medium leading-none transition-colors ${
              selected ? 'text-droid-text' : 'text-droid-text-secondary hover:text-droid-text'
            }`}
            title="Double-click to rename"
          >
            {frame.name}
          </button>
        )}
        <span className="shrink-0 font-mono text-[10.5px] tracking-tight text-droid-text-muted">
          {size.width}×{size.height}
        </span>
        {frame.agentLabel && (
          <span className="shrink-0 rounded-full bg-[#ee6018]/15 px-1.5 py-0.5 font-mono text-[10px] text-[#ee6018]">
            {frame.agentLabel}
          </span>
        )}
      </div>

      {/* Toolbar on selection */}
      <AnimatePresence>
        {selected && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.96 }}
            transition={{ type: 'spring', damping: 22, stiffness: 320 }}
            className="pointer-events-auto absolute right-0 flex items-center gap-0.5 rounded-lg border border-droid-border border-t-[#ee6018]/25 bg-droid-surface/85 px-1 py-1 shadow-xl backdrop-blur-lg"
            style={{ top: -headerScaledOffset - 6 }}
          >
            <ToolbarButton label="Viewport" onClick={cycleViewport}>
              {(() => {
                const Icon = VIEWPORT_ICON[frame.mode] ?? Monitor;
                return <Icon className="h-3.5 w-3.5" />;
              })()}
            </ToolbarButton>
            <ToolbarButton
              label="Interact"
              onClick={() => { studioDispatch({ type: 'SET_INTERACTING', id: frame.id }); }}
            >
              <Play className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton label="Duplicate" onClick={() => { onDuplicate(frame); }}>
              <Copy className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton
              label="Delete"
              danger
              onClick={() => { studioDispatch({ type: 'REMOVE_FRAME', id: frame.id }); }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </ToolbarButton>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Body hit area — captures select/drag only in the Select tool, and only
          when not interacting so clicks reach the live app. Double-click enters
          interact mode (configurable in Studio settings). */}
      {tool === 'select' && !interacting && (
        <div
          className="absolute inset-0"
          style={{ pointerEvents: 'auto', cursor: active ? 'grab' : 'default' }}
          onPointerDown={beginDrag}
          onPointerMove={onDragMove}
          onPointerUp={(e) => { endDrag(e, e.shiftKey); }}
          onDoubleClick={() => {
            if (studio.settings.interactOnDoubleClick)
              studioDispatch({ type: 'SET_INTERACTING', id: frame.id });
          }}
        />
      )}

      {/* Interacting badge — exit back to canvas gestures */}
      {interacting && (
        <div
          className="pointer-events-auto absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[#ee6018]/40 bg-droid-surface/90 px-2.5 py-1 text-[11px] text-droid-text shadow-lg backdrop-blur"
          style={{ top: rect.height + 8 }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[#ee6018]" />
          Interacting
          <button
            onClick={() => { studioDispatch({ type: 'SET_INTERACTING', id: null }); }}
            className="ml-0.5 text-droid-text-muted transition-colors hover:text-droid-text"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  children,
  label,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
        danger
          ? 'text-droid-text-muted hover:bg-[#c0563a]/15 hover:text-[#e0806a]'
          : 'text-droid-text-secondary hover:bg-white/10 hover:text-droid-text'
      }`}
    >
      {children}
    </button>
  );
}
