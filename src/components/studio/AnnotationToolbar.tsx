import {
  ArrowRight,
  Check,
  Circle,
  Eraser,
  Minus,
  PaintBucket,
  Pencil,
  RectangleHorizontal,
  Ruler,
  Slash,
  Square,
  Undo2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Popover } from '../environment/Popover';
import {
  useStudioCanvas,
  type StudioAnnotationColor,
  type StudioAnnotationFill,
  type StudioAnnotationKind,
  type StudioStrokeWidth,
} from './StudioCanvasContext';
import { ANNOTATION_COLORS } from './studioAnnotations';

const TOOLS: {
  kind: StudioAnnotationKind;
  label: string;
  icon: typeof Pencil;
}[] = [
  { kind: 'pencil', label: 'Pencil', icon: Pencil },
  { kind: 'line', label: 'Line', icon: Minus },
  { kind: 'arrow', label: 'Arrow', icon: ArrowRight },
  { kind: 'rectangle', label: 'Rectangle', icon: RectangleHorizontal },
  { kind: 'square', label: 'Square', icon: Square },
  { kind: 'ellipse', label: 'Ellipse', icon: Circle },
  { kind: 'measure', label: 'Measure', icon: Ruler },
];

const COLORS = Object.keys(ANNOTATION_COLORS) as StudioAnnotationColor[];
const STROKES: StudioStrokeWidth[] = [1, 2, 4];

export default function AnnotationToolbar() {
  const { studio, studioDispatch } = useStudioCanvas();
  if (studio.tool !== 'draw') return null;

  return (
    <div
      data-studio-dismissable-layer
      className="studio-floating-surface pointer-events-auto absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl p-1"
    >
      {TOOLS.map((tool) => (
        <ToolbarButton
          key={tool.kind}
          label={tool.label}
          detail={toolHint(tool.kind)}
          active={studio.drawingStyle.kind === tool.kind}
          onClick={() => {
            studioDispatch({ type: 'SET_DRAWING_KIND', kind: tool.kind });
          }}
        >
          <tool.icon className="h-4 w-4" strokeWidth={1.75} />
        </ToolbarButton>
      ))}

      <Divider />
      {COLORS.map((color) => (
        <ToolbarButton
          key={color}
          label={`${capitalize(color)} stroke`}
          active={studio.drawingStyle.color === color}
          onClick={() => {
            studioDispatch({ type: 'SET_DRAWING_COLOR', color });
          }}
        >
          <span
            className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10"
            style={{ background: ANNOTATION_COLORS[color] }}
          />
        </ToolbarButton>
      ))}

      <FillPicker />

      <Divider />
      {STROKES.map((strokeWidth) => (
        <ToolbarButton
          key={strokeWidth}
          label={`${String(strokeWidth)} px stroke`}
          active={studio.drawingStyle.strokeWidth === strokeWidth}
          onClick={() => {
            studioDispatch({ type: 'SET_DRAWING_STROKE', strokeWidth });
          }}
        >
          <span
            className="w-3.5 rounded-full bg-current"
            style={{ height: Math.max(1, strokeWidth) }}
          />
        </ToolbarButton>
      ))}

      <Divider />
      <ToolbarButton
        label="Undo drawing"
        disabled={studio.annotations.length === 0}
        onClick={() => {
          studioDispatch({ type: 'UNDO_ANNOTATION' });
        }}
      >
        <Undo2 className="h-4 w-4" strokeWidth={1.75} />
      </ToolbarButton>
      <ToolbarButton
        label="Clear drawings"
        disabled={studio.annotations.length === 0}
        onClick={() => {
          studioDispatch({ type: 'CLEAR_ANNOTATIONS' });
        }}
      >
        <Eraser className="h-4 w-4" strokeWidth={1.75} />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  children,
  label,
  detail,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  detail?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`group relative flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
        active
          ? 'bg-droid-accent/10 text-droid-accent'
          : 'text-droid-text-muted hover:bg-droid-active/70 hover:text-droid-text'
      } disabled:cursor-not-allowed disabled:opacity-30`}
    >
      {children}
      <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-droid-border bg-droid-elevated px-2 py-1 text-[10.5px] font-normal text-droid-text opacity-0 shadow-lg transition-opacity delay-200 duration-150 group-hover:block group-hover:opacity-100">
        {label}
        {detail && <span className="ml-1 text-droid-text-muted">· {detail}</span>}
      </span>
    </button>
  );
}

function FillPicker() {
  const { studio, studioDispatch } = useStudioCanvas();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fill = studio.drawingStyle.fill;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title="Shape fill"
        aria-label="Shape fill"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className={`group relative flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
          fill === 'none'
            ? 'text-droid-text-muted hover:bg-droid-active/70 hover:text-droid-text'
            : 'bg-droid-accent/10 text-droid-accent'
        }`}
      >
        <PaintBucket className="h-4 w-4" strokeWidth={1.75} />
        <span
          className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ring-1 ring-droid-surface"
          style={{
            background: fill === 'none' ? 'transparent' : ANNOTATION_COLORS[fill],
          }}
        />
        <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-droid-border bg-droid-elevated px-2 py-1 text-[10.5px] font-normal text-droid-text opacity-0 shadow-lg transition-opacity delay-200 duration-150 group-hover:block group-hover:opacity-100">
          Shape fill
        </span>
      </button>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        anchorRef={triggerRef}
        label="Choose shape fill"
        align="left"
        width={164}
        className="studio-popover p-1.5"
      >
        <FillRow
          fill="none"
          current={fill}
          onPick={(value) => {
            studioDispatch({ type: 'SET_DRAWING_FILL', fill: value });
            setOpen(false);
          }}
        />
        {COLORS.map((color) => (
          <FillRow
            key={color}
            fill={color}
            current={fill}
            onPick={(value) => {
              studioDispatch({ type: 'SET_DRAWING_FILL', fill: value });
              setOpen(false);
            }}
          />
        ))}
      </Popover>
    </>
  );
}

function FillRow({
  fill,
  current,
  onPick,
}: {
  fill: StudioAnnotationFill;
  current: StudioAnnotationFill;
  onPick: (fill: StudioAnnotationFill) => void;
}) {
  const selected = fill === current;
  return (
    <button
      type="button"
      onClick={() => {
        onPick(fill);
      }}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] transition-colors ${
        selected ? 'bg-droid-accent/10 text-droid-accent' : 'text-droid-text hover:bg-droid-active'
      }`}
    >
      <span className="flex h-4 w-4 items-center justify-center">
        {fill === 'none' ? (
          <Slash className="h-3.5 w-3.5 text-droid-text-muted" />
        ) : (
          <span
            className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10"
            style={{ background: ANNOTATION_COLORS[fill] }}
          />
        )}
      </span>
      <span className="flex-1">{fill === 'none' ? 'No fill' : capitalize(fill)}</span>
      {selected && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
    </button>
  );
}

function Divider() {
  return <div className="mx-0.5 h-4 w-px bg-droid-border" />;
}

function toolHint(kind: StudioAnnotationKind): string | undefined {
  if (kind === 'line' || kind === 'arrow' || kind === 'measure') return 'Shift locks angle';
  if (kind === 'rectangle' || kind === 'ellipse') return 'Shift makes equal';
  return undefined;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
