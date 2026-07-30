import { useStudioCanvas, type StudioAnnotation } from './StudioCanvasContext';
import type { Point } from './studioCanvasMath';
import {
  ANNOTATION_COLORS,
  annotationHandles,
  annotationRect,
  annotationScreenBounds,
  annotationScreenPoints,
  measureDistance,
} from './studioAnnotations';

export default function CanvasAnnotationLayer({ draft }: { draft: StudioAnnotation | null }) {
  const { studio } = useStudioCanvas();
  const annotations = draft ? [...studio.annotations, draft] : studio.annotations;
  if (annotations.length === 0) return null;

  return (
    <svg
      aria-label="Canvas annotations"
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
    >
      {annotations.map((annotation) => (
        <AnnotationShape
          key={annotation.id}
          annotation={annotation}
          isDraft={annotation === draft}
        />
      ))}
      {studio.tool === 'select' && studio.selectedAnnotationId && (
        <SelectionHandles annotationId={studio.selectedAnnotationId} />
      )}
    </svg>
  );
}

function AnnotationShape({
  annotation,
  isDraft,
}: {
  annotation: StudioAnnotation;
  isDraft: boolean;
}) {
  const { studio } = useStudioCanvas();
  const points = annotationScreenPoints(annotation, studio.frames, studio.view);
  const color = ANNOTATION_COLORS[annotation.color];
  const fill = annotation.fill === 'none' ? 'transparent' : ANNOTATION_COLORS[annotation.fill];
  const strokeWidth = annotation.strokeWidth;
  const opacity = isDraft ? 0.72 : 0.96;

  if (annotation.kind === 'pencil') {
    return (
      <polyline
        points={points.map((point) => `${String(point.x)},${String(point.y)}`).join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={opacity}
      />
    );
  }

  if (points.length < 2) return null;
  const [start, end] = points;
  if (
    annotation.kind === 'rectangle' ||
    annotation.kind === 'square' ||
    annotation.kind === 'ellipse'
  ) {
    const rect = annotationRect({
      ...annotation,
      points,
    });
    if (!rect) return null;
    const shapeProps = {
      fill,
      fillOpacity: annotation.fill === 'none' ? 0 : 0.18,
      stroke: color,
      strokeWidth,
      opacity,
    };
    return annotation.kind === 'ellipse' ? (
      <ellipse
        cx={rect.x + rect.width / 2}
        cy={rect.y + rect.height / 2}
        rx={rect.width / 2}
        ry={rect.height / 2}
        {...shapeProps}
      />
    ) : (
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        rx={annotation.kind === 'rectangle' ? 4 : 2}
        {...shapeProps}
      />
    );
  }

  return (
    <g opacity={opacity}>
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      {annotation.kind === 'arrow' && <ArrowHead start={start} end={end} color={color} />}
      {annotation.kind === 'measure' && (
        <Measurement annotation={annotation} start={start} end={end} color={color} />
      )}
    </g>
  );
}

function ArrowHead({ start, end, color }: { start: Point; end: Point; color: string }) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const size = 9;
  const left = {
    x: end.x - Math.cos(angle - Math.PI / 6) * size,
    y: end.y - Math.sin(angle - Math.PI / 6) * size,
  };
  const right = {
    x: end.x - Math.cos(angle + Math.PI / 6) * size,
    y: end.y - Math.sin(angle + Math.PI / 6) * size,
  };
  return (
    <path
      d={`M ${String(left.x)} ${String(left.y)} L ${String(end.x)} ${String(end.y)} L ${String(right.x)} ${String(right.y)}`}
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function SelectionHandles({ annotationId }: { annotationId: string }) {
  const { studio } = useStudioCanvas();
  const annotation = studio.annotations.find((candidate) => candidate.id === annotationId);
  if (!annotation) return null;
  const bounds = annotationScreenBounds(annotation, studio.frames, studio.view);
  if (!bounds) return null;
  const handles = annotationHandles(annotation, studio.frames, studio.view);
  return (
    <g>
      <rect
        x={bounds.x - 5}
        y={bounds.y - 5}
        width={bounds.width + 10}
        height={bounds.height + 10}
        rx={5}
        fill="none"
        stroke="var(--droid-accent)"
        strokeWidth={1}
        strokeDasharray="4 3"
        opacity={0.8}
      />
      {handles.map(([name, point]) => (
        <rect
          key={name}
          x={point.x - 4}
          y={point.y - 4}
          width={8}
          height={8}
          rx={2}
          fill="var(--droid-surface)"
          stroke="var(--droid-accent)"
          strokeWidth={1.5}
        />
      ))}
    </g>
  );
}

function Measurement({
  annotation,
  start,
  end,
  color,
}: {
  annotation: StudioAnnotation;
  start: Point;
  end: Point;
  color: string;
}) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const capX = Math.sin(angle) * 5;
  const capY = -Math.cos(angle) * 5;
  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const label = `${String(Math.round(measureDistance(annotation)))} px`;
  return (
    <>
      <line
        x1={start.x - capX}
        y1={start.y - capY}
        x2={start.x + capX}
        y2={start.y + capY}
        stroke={color}
        strokeWidth={1.5}
      />
      <line
        x1={end.x - capX}
        y1={end.y - capY}
        x2={end.x + capX}
        y2={end.y + capY}
        stroke={color}
        strokeWidth={1.5}
      />
      <g transform={`translate(${String(middle.x)} ${String(middle.y - 13)})`}>
        <rect x={-24} y={-9} width={48} height={18} rx={7} fill="var(--droid-surface)" />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--droid-text)"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          fontSize={10.5}
        >
          {label}
        </text>
      </g>
    </>
  );
}
