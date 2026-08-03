import assert from 'node:assert/strict';
import test from 'node:test';
import {
  duplicateStudioFrame,
  emptyStudioCanvasState,
  studioCanvasReducer,
  type StudioAnnotation,
  type StudioCanvasImage,
  type StudioFrame,
} from './StudioCanvasContext';

function frame(overrides: Partial<StudioFrame> = {}): StudioFrame {
  return {
    id: 'frame-1',
    name: 'Home',
    url: 'http://localhost:5173',
    mode: 'desktop',
    kind: 'route',
    x: 0,
    y: 0,
    status: 'failed',
    reloadRevision: 2,
    error: 'Offline',
    ...overrides,
  };
}

function annotation(overrides: Partial<StudioAnnotation> = {}): StudioAnnotation {
  return {
    id: 'note-1',
    kind: 'measure',
    points: [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
    ],
    color: 'blue',
    fill: 'none',
    strokeWidth: 2,
    frameId: 'frame-1',
    ...overrides,
  };
}

function canvasImage(overrides: Partial<StudioCanvasImage> = {}): StudioCanvasImage {
  return {
    id: 'canvas-image-1',
    libraryId: 'canvas-image-1',
    src: 'data:image/png;base64,YWJj',
    name: 'Soft dashboard',
    tag: 'inspiration',
    x: 100,
    y: 120,
    width: 320,
    height: 200,
    naturalWidth: 1600,
    naturalHeight: 1000,
    ...overrides,
  };
}

test('RELOAD_FRAME starts a real new load and clears the previous error', () => {
  const initial = { ...emptyStudioCanvasState(), frames: [frame()] };
  const next = studioCanvasReducer(initial, { type: 'RELOAD_FRAME', id: 'frame-1' });

  assert.equal(next.frames[0].reloadRevision, 3);
  assert.equal(next.frames[0].status, 'loading');
  assert.equal(next.frames[0].error, undefined);
  assert.equal(initial.frames[0].reloadRevision, 2);
});

test('duplicate frame input preserves its rendering kind and custom dimensions', () => {
  const original = frame({
    id: 'prototype-1',
    kind: 'prototype',
    width: 420,
    height: 280,
  });
  const initial = { ...emptyStudioCanvasState(), frames: [original] };
  const duplicated = studioCanvasReducer(initial, {
    type: 'ADD_FRAME',
    frame: duplicateStudioFrame(original),
  });
  const copy = duplicated.frames[1];

  assert.equal(copy.name, 'Home copy');
  assert.equal(copy.kind, 'prototype');
  assert.equal(copy.width, 420);
  assert.equal(copy.height, 280);
});

test('frame focus requests are repeatable ephemeral canvas intents', () => {
  const initial = emptyStudioCanvasState();
  const first = studioCanvasReducer(initial, { type: 'REQUEST_FRAME_FOCUS', id: 'brand-book' });
  const second = studioCanvasReducer(first, { type: 'REQUEST_FRAME_FOCUS', id: 'brand-book' });

  assert.deepEqual(first.focusFrameRequest, { id: 'brand-book', revision: 1 });
  assert.deepEqual(second.focusFrameRequest, { id: 'brand-book', revision: 2 });

  const hydrated = studioCanvasReducer(second, {
    type: 'HYDRATE',
    state: emptyStudioCanvasState(),
  });
  const afterHydrate = studioCanvasReducer(hydrated, {
    type: 'REQUEST_FRAME_FOCUS',
    id: 'brand-book',
  });
  assert.equal(hydrated.focusFrameRequest, null);
  assert.deepEqual(afterHydrate.focusFrameRequest, { id: 'brand-book', revision: 1 });
});

test('new annotations are attached as prompt context and undo removes both', () => {
  const initial = emptyStudioCanvasState();
  const added = studioCanvasReducer(initial, {
    type: 'ADD_ANNOTATION',
    annotation: annotation({ frameId: undefined }),
  });

  assert.deepEqual(added.attachedAnnotationIds, ['note-1']);
  assert.equal(added.annotations.length, 1);
  assert.equal(added.selectedAnnotationId, 'note-1');

  const undone = studioCanvasReducer(added, { type: 'UNDO_ANNOTATION' });
  assert.deepEqual(undone.annotations, []);
  assert.deepEqual(undone.attachedAnnotationIds, []);
  assert.equal(undone.selectedAnnotationId, null);
});

test('selected annotations update and delete without leaving stale context', () => {
  const added = studioCanvasReducer(emptyStudioCanvasState(), {
    type: 'ADD_ANNOTATION',
    annotation: annotation({ frameId: undefined }),
  });
  const moved = annotation({
    frameId: undefined,
    points: [
      { x: 30, y: 40 },
      { x: 130, y: 40 },
    ],
  });
  const updated = studioCanvasReducer(added, {
    type: 'UPDATE_ANNOTATION',
    id: moved.id,
    annotation: moved,
  });
  assert.deepEqual(updated.annotations[0].points, moved.points);

  const removed = studioCanvasReducer(updated, {
    type: 'REMOVE_ANNOTATION',
    id: moved.id,
  });
  assert.deepEqual(removed.annotations, []);
  assert.deepEqual(removed.attachedAnnotationIds, []);
  assert.equal(removed.selectedAnnotationId, null);
});

test('switching away from Select exits live frame interaction', () => {
  const interacting = {
    ...emptyStudioCanvasState(),
    frames: [frame()],
    interactingFrameId: 'frame-1',
  };
  const drawing = studioCanvasReducer(interacting, { type: 'SET_TOOL', tool: 'draw' });
  assert.equal(drawing.interactingFrameId, null);
  assert.equal(drawing.tool, 'draw');
});

test('removing a frame also removes its anchored drawing context', () => {
  const initial = {
    ...emptyStudioCanvasState(),
    frames: [frame()],
    annotations: [annotation(), annotation({ id: 'canvas-note', frameId: undefined })],
    attachedAnnotationIds: ['note-1', 'canvas-note'],
  };
  const next = studioCanvasReducer(initial, { type: 'REMOVE_FRAME', id: 'frame-1' });

  assert.deepEqual(
    next.annotations.map((item) => item.id),
    ['canvas-note'],
  );
  assert.deepEqual(next.attachedAnnotationIds, ['canvas-note']);
});

test('canvas images can be added, arranged, tagged, and removed', () => {
  const initial = {
    ...emptyStudioCanvasState(),
    frames: [frame()],
    selectedFrameIds: ['frame-1'],
  };
  const added = studioCanvasReducer(initial, {
    type: 'ADD_CANVAS_IMAGE',
    image: canvasImage(),
  });
  assert.equal(added.selectedImageId, 'canvas-image-1');
  assert.deepEqual(added.selectedFrameIds, []);
  assert.deepEqual(added.attachedImageIds, ['canvas-image-1']);

  const arranged = studioCanvasReducer(added, {
    type: 'UPDATE_CANVAS_IMAGE',
    id: 'canvas-image-1',
    patch: { x: 240, y: 80, width: 400, height: 250, tag: 'moodboard' },
  });
  assert.deepEqual(
    {
      x: arranged.images[0].x,
      y: arranged.images[0].y,
      width: arranged.images[0].width,
      height: arranged.images[0].height,
      tag: arranged.images[0].tag,
    },
    { x: 240, y: 80, width: 400, height: 250, tag: 'moodboard' },
  );

  const cleared = studioCanvasReducer(arranged, { type: 'CLEAR_CANVAS_IMAGE_CONTEXT' });
  assert.deepEqual(cleared.attachedImageIds, []);
  assert.equal(cleared.images.length, 1);

  const reattached = studioCanvasReducer(cleared, {
    type: 'SET_CANVAS_IMAGE_ATTACHED',
    id: 'canvas-image-1',
    attached: true,
  });
  assert.deepEqual(reattached.attachedImageIds, ['canvas-image-1']);

  const removed = studioCanvasReducer(reattached, {
    type: 'REMOVE_CANVAS_IMAGE',
    id: 'canvas-image-1',
  });
  assert.deepEqual(removed.images, []);
  assert.deepEqual(removed.attachedImageIds, []);
  assert.equal(removed.selectedImageId, null);
});
