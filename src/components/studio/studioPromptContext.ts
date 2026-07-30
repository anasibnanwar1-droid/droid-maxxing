import {
  sizeOf,
  type StudioAnnotation,
  type StudioCanvasImage,
  type StudioCanvasState,
  type StudioFrame,
} from './StudioCanvasContext';
import { annotationRect, measureDistance } from './studioAnnotations';

const DEFAULT_DRAWING_INSTRUCTION = 'Apply the attached canvas references.';

export interface StudioPrompt {
  prompt: string;
  displayText: string;
}

export function buildStudioPrompt(instruction: string, studio: StudioCanvasState): StudioPrompt {
  const displayText = instruction.trim() || DEFAULT_DRAWING_INSTRUCTION;
  const selectedFrames = studio.frames
    .filter((frame) => studio.selectedFrameIds.includes(frame.id))
    .map(frameReference);
  const annotations = studio.annotations
    .filter((annotation) => studio.attachedAnnotationIds.includes(annotation.id))
    .map((annotation) => annotationReference(annotation, studio.frames));
  const images = studio.images
    .filter((image) => studio.attachedImageIds.includes(image.id))
    .map(canvasImageReference);
  const elements = studio.selection.map((selection) => ({
    frame: selection.frameName,
    label: selection.label,
    ...(selection.tag ? { tag: selection.tag } : {}),
    ...(selection.selector ? { selector: selection.selector } : {}),
    ...(selection.file ? { file: selection.file, line: selection.line } : {}),
  }));

  if (
    selectedFrames.length === 0 &&
    annotations.length === 0 &&
    elements.length === 0 &&
    images.length === 0
  ) {
    return { prompt: displayText, displayText };
  }

  const context = JSON.stringify(
    {
      coordinateSystem: 'CSS pixels; frame annotations are relative to the frame viewport',
      annotationGuidance:
        'Treat geometry, measurements, stroke, fill, and frame anchors as precise user intent for the requested UI or wireframe.',
      imageGuidance:
        'Each canvas image is stored at original resolution. Call design_reference_library with its libraryId to inspect the actual image before designing.',
      selectedFrames,
      elements,
      annotations,
      images,
    },
    null,
    2,
  );
  return {
    displayText,
    prompt: `${displayText}\n\nDROIDEX DESIGN reference pack:\n${context}`,
  };
}

function canvasImageReference(image: StudioCanvasImage) {
  return {
    id: image.id,
    libraryId: image.libraryId,
    name: clean(image.name),
    tag: image.tag,
    canvasRect: {
      x: round(image.x),
      y: round(image.y),
      width: round(image.width),
      height: round(image.height),
    },
    originalResolution: {
      width: image.naturalWidth,
      height: image.naturalHeight,
    },
  };
}

function frameReference(frame: StudioFrame) {
  const size = sizeOf(frame);
  return {
    id: frame.id,
    name: clean(frame.name),
    url: clean(frame.url),
    viewport: { width: size.width, height: size.height },
  };
}

function annotationReference(annotation: StudioAnnotation, frames: StudioFrame[]) {
  const frame = annotation.frameId
    ? frames.find((candidate) => candidate.id === annotation.frameId)
    : undefined;
  const base = {
    id: annotation.id,
    kind: annotation.kind,
    anchor: frame ? frameReference(frame) : { canvas: true },
    color: annotation.color,
    fill: annotation.fill,
    strokeWidthPx: annotation.strokeWidth,
  };
  if (annotation.kind === 'pencil') {
    return { ...base, points: annotation.points.map(roundPoint) };
  }
  if (
    annotation.kind === 'rectangle' ||
    annotation.kind === 'square' ||
    annotation.kind === 'ellipse'
  ) {
    const rect = annotationRect(annotation);
    if (!rect) return base;
    return {
      ...base,
      rect: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      },
    };
  }
  const [start, end] = annotation.points;
  return {
    ...base,
    start: roundPoint(start),
    end: roundPoint(end),
    ...(annotation.kind === 'measure' ? { distancePx: round(measureDistance(annotation)) } : {}),
  };
}

function roundPoint(point: { x: number; y: number }) {
  return { x: round(point.x), y: round(point.y) };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}
