import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyStudioCanvasState,
  studioCanvasReducer,
  type StudioAnnotation,
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

test('RELOAD_FRAME starts a real new load and clears the previous error', () => {
  const initial = { ...emptyStudioCanvasState(), frames: [frame()] };
  const next = studioCanvasReducer(initial, { type: 'RELOAD_FRAME', id: 'frame-1' });

  assert.equal(next.frames[0].reloadRevision, 3);
  assert.equal(next.frames[0].status, 'loading');
  assert.equal(next.frames[0].error, undefined);
  assert.equal(initial.frames[0].reloadRevision, 2);
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
