import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyStudioCanvasState,
  type StudioAnnotation,
  type StudioFrame,
} from './StudioCanvasContext';
import { buildStudioPrompt } from './studioPromptContext';
import { fitRects, MAX_ZOOM, readableFrameRect } from './studioCanvasMath';
import {
  annotationHandles,
  annotationPointToWorld,
  hitTestAnnotation,
  isMeaningfulAnnotation,
  measureDistance,
  moveAnnotation,
  resizeAnnotation,
  snapLineEnd,
  squareEnd,
  topFrameAtPoint,
} from './studioAnnotations';

const frame: StudioFrame = {
  id: 'frame-1',
  name: 'Checkout',
  url: 'http://localhost:5173/checkout',
  mode: 'desktop',
  kind: 'route',
  x: 300,
  y: 200,
  status: 'ready',
  reloadRevision: 0,
};

const measure: StudioAnnotation = {
  id: 'note-1',
  kind: 'measure',
  points: [
    { x: 10, y: 20 },
    { x: 110, y: 20 },
  ],
  color: 'red',
  fill: 'none',
  strokeWidth: 2,
  frameId: frame.id,
};

test('frame-local annotations follow their frame without changing measurements', () => {
  assert.deepEqual(annotationPointToWorld(measure, measure.points[0], [frame]), {
    x: 310,
    y: 220,
  });
  assert.equal(measureDistance(measure), 100);
  assert.equal(topFrameAtPoint([frame], { x: 400, y: 300 })?.id, frame.id);
});

test('drawing constraints create square geometry and 45-degree lines', () => {
  assert.deepEqual(squareEnd({ x: 0, y: 0 }, { x: 20, y: -8 }), { x: 20, y: -20 });
  const snapped = snapLineEnd({ x: 0, y: 0 }, { x: 20, y: 8 });
  assert.ok(Math.abs(snapped.y) < 0.0001);
  assert.ok(Math.abs(Math.hypot(snapped.x, snapped.y) - Math.hypot(20, 8)) < 0.0001);
});

test('cancelled one-point shape drafts are safely discarded', () => {
  assert.equal(
    isMeaningfulAnnotation({
      id: 'cancelled',
      kind: 'rectangle',
      points: [{ x: 10, y: 10 }],
      color: 'blue',
      fill: 'none',
      strokeWidth: 2,
    }),
    false,
  );
});

test('canvas shapes can be selected, moved, and resized', () => {
  const rectangle: StudioAnnotation = {
    id: 'shape-1',
    kind: 'rectangle',
    points: [
      { x: 10, y: 10 },
      { x: 50, y: 40 },
    ],
    color: 'blue',
    fill: 'amber',
    strokeWidth: 2,
  };
  const view = emptyStudioCanvasState().view;
  assert.equal(hitTestAnnotation(rectangle, { x: 30, y: 25 }, [], view), true);
  assert.deepEqual(
    annotationHandles(rectangle, [], view).map(([handle]) => handle),
    ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'],
  );

  const moved = moveAnnotation(rectangle, 15, -5);
  assert.deepEqual(moved.points, [
    { x: 25, y: 5 },
    { x: 65, y: 35 },
  ]);

  const resized = resizeAnnotation(rectangle, 'se', { x: 80, y: 70 });
  assert.deepEqual(resized.points, [
    { x: 10, y: 10 },
    { x: 80, y: 70 },
  ]);
  assert.deepEqual(resizeAnnotation(rectangle, 'e', { x: 90, y: 25 }).points, [
    { x: 10, y: 10 },
    { x: 90, y: 40 },
  ]);
});

test('prompt context includes visible drawing geometry while keeping the user bubble clean', () => {
  const ellipse: StudioAnnotation = {
    id: 'shape-2',
    kind: 'ellipse',
    points: [
      { x: 30, y: 40 },
      { x: 180, y: 120 },
    ],
    color: 'green',
    fill: 'amber',
    strokeWidth: 4,
    frameId: frame.id,
  };
  const studio = {
    ...emptyStudioCanvasState(),
    frames: [frame],
    selectedFrameIds: [frame.id],
    annotations: [measure, ellipse],
    attachedAnnotationIds: [measure.id, ellipse.id],
  };
  const result = buildStudioPrompt('Tighten this spacing', studio);

  assert.equal(result.displayText, 'Tighten this spacing');
  assert.match(result.prompt, /DROIDEX DESIGN reference pack/);
  assert.match(result.prompt, /"distancePx": 100/);
  assert.match(result.prompt, /"kind": "ellipse"/);
  assert.match(result.prompt, /"fill": "amber"/);
  assert.match(result.prompt, /localhost:5173\/checkout/);
});

test('drawing-only prompts receive an explicit instruction', () => {
  const studio = {
    ...emptyStudioCanvasState(),
    frames: [frame],
    annotations: [measure],
    attachedAnnotationIds: [measure.id],
  };
  const result = buildStudioPrompt('', studio);
  assert.equal(result.displayText, 'Apply the attached canvas references.');
});

test('canvas moodboards pass agent-visible library ids without embedding base64', () => {
  const studio = {
    ...emptyStudioCanvasState(),
    images: [
      {
        id: 'canvas-image-1',
        libraryId: 'canvas-image-1',
        src: 'data:image/png;base64,do-not-leak',
        name: 'Warm editorial',
        tag: 'moodboard' as const,
        x: 120,
        y: 80,
        width: 360,
        height: 240,
        naturalWidth: 1800,
        naturalHeight: 1200,
      },
    ],
    attachedImageIds: ['canvas-image-1'],
  };
  const result = buildStudioPrompt('Use this visual direction', studio);

  assert.match(result.prompt, /"libraryId": "canvas-image-1"/);
  assert.match(result.prompt, /"tag": "moodboard"/);
  assert.match(result.prompt, /"width": 1800/);
  assert.match(result.prompt, /design_reference_library/);
  assert.doesNotMatch(result.prompt, /do-not-leak/);
});

test('canvas images remain on the board after their prompt context is consumed', () => {
  const studio = {
    ...emptyStudioCanvasState(),
    images: [
      {
        id: 'canvas-image-1',
        libraryId: 'canvas-image-1',
        src: 'data:image/png;base64,unused',
        name: 'Reference',
        tag: 'reference' as const,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        naturalWidth: 100,
        naturalHeight: 100,
      },
    ],
    attachedImageIds: [],
  };

  assert.deepEqual(buildStudioPrompt('Continue designing', studio), {
    prompt: 'Continue designing',
    displayText: 'Continue designing',
  });
});

test('explicit fit may upscale while automatic fit keeps pages at 100 percent', () => {
  const rects = [{ x: 0, y: 0, width: 200, height: 100 }];
  const automatic = fitRects(rects, { width: 1000, height: 800 }, 100);
  const explicit = fitRects(rects, { width: 1000, height: 800 }, 100, MAX_ZOOM);

  assert.equal(automatic.zoom, 1);
  assert.equal(explicit.zoom, 3);
  assert.deepEqual(explicit.pan, { x: 200, y: 250 });
});

test('generated tall documents focus a readable top viewport', () => {
  const viewport = { width: 1200, height: 800 };
  const tall = readableFrameRect({ x: 40, y: 80, width: 1200, height: 3200 }, viewport, 100);
  const ordinary = readableFrameRect({ x: 40, y: 80, width: 1200, height: 800 }, viewport, 100);

  assert.deepEqual(tall, { x: 40, y: 80, width: 1200, height: 720 });
  assert.deepEqual(ordinary, { x: 40, y: 80, width: 1200, height: 800 });
});
