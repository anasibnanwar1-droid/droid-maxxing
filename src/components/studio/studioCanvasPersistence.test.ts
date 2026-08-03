import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanvasDocument, CanvasDocumentContent, ServerEvent } from '../../types/bridge';
import { emptyStudioCanvasState, type StudioCanvasState } from './StudioCanvasContext';
import {
  CanvasSaveCoordinator,
  DRAFT_CANVAS_ID,
  canvasIdForSession,
  hydrateStudioCanvas,
  serializeStudioCanvas,
  type CanvasPersistenceTransport,
  type HydratedStudioCanvas,
} from './studioCanvasPersistence';

test('serialization keeps durable sources and ids while excluding runtime-only data', () => {
  const studio: StudioCanvasState = {
    ...emptyStudioCanvasState(),
    frames: [
      {
        id: 'durable-frame',
        name: 'Dashboard',
        url: 'http://127.0.0.1:43210/runtime',
        source: { type: 'workspace-html', relativePath: 'preview/dashboard.html' },
        mode: 'desktop',
        kind: 'prototype',
        x: 40,
        y: 80,
        status: 'ready',
        reloadRevision: 7,
      },
      {
        id: 'runtime-only',
        name: 'Temporary',
        url: 'http://127.0.0.1:9999/temporary',
        mode: 'desktop',
        kind: 'showcase',
        x: 900,
        y: 80,
        status: 'loading',
        reloadRevision: 0,
      },
    ],
    annotations: [
      {
        id: 'durable-note',
        kind: 'measure',
        points: [
          { x: 10, y: 20 },
          { x: 100, y: 20 },
        ],
        color: 'blue',
        fill: 'none',
        strokeWidth: 2,
        frameId: 'durable-frame',
      },
      {
        id: 'temporary-note',
        kind: 'line',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        color: 'red',
        fill: 'none',
        strokeWidth: 1,
        frameId: 'runtime-only',
      },
    ],
    images: [
      {
        id: 'image-placement',
        libraryId: 'canvas-library-image',
        src: 'data:image/png;base64,YWJj',
        name: 'Reference',
        tag: 'reference',
        x: 1200,
        y: 100,
        width: 320,
        height: 200,
        naturalWidth: 1600,
        naturalHeight: 1000,
      },
    ],
    selectedFrameIds: ['durable-frame'],
    interactingFrameId: 'durable-frame',
  };

  const serialized = serializeStudioCanvas(studio);
  assert.deepEqual(
    serialized.content.frames.map((frame) => frame.id),
    ['durable-frame'],
  );
  assert.deepEqual(
    serialized.content.annotations.map((annotation) => annotation.id),
    ['durable-note'],
  );
  assert.deepEqual(serialized.content.images, [
    {
      id: 'image-placement',
      libraryId: 'canvas-library-image',
      tag: 'reference',
      x: 1200,
      y: 100,
      width: 320,
      height: 200,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(serialized.content),
    /127\.0\.0\.1|base64|selectedFrameIds|interactingFrameId|reloadRevision|status/,
  );
  assert.equal(serialized.notices.length, 2);
});

test('hydration reconstructs runtime frames and library images while resetting ephemeral state', () => {
  const hydrated = hydrateStudioCanvas(
    document('thread-a', 2, 1.25),
    [{ frameId: 'frame-home', url: 'http://127.0.0.1:4123/preview/' }],
    [
      {
        libraryId: 'canvas-library-image',
        name: 'Reference board',
        url: 'http://127.0.0.1:4123/canvas-image/reference.png',
      },
    ],
  );

  assert.equal(hydrated.state.view.zoom, 1.25);
  assert.equal(hydrated.state.frames[0]?.source?.type, 'url');
  assert.equal(hydrated.state.frames[0]?.url, 'http://127.0.0.1:4123/preview/');
  assert.equal(hydrated.state.frames[0]?.status, 'loading');
  assert.equal(hydrated.state.images[0]?.libraryId, 'canvas-library-image');
  assert.equal(hydrated.state.images[0]?.src, 'http://127.0.0.1:4123/canvas-image/reference.png');
  assert.equal(hydrated.state.images[0]?.tag, 'inspiration');
  assert.deepEqual(hydrated.state.selectedFrameIds, []);
  assert.deepEqual(hydrated.state.attachedAnnotationIds, []);
  assert.equal(hydrated.state.interactingFrameId, null);
});

test('same-thread reopen and app reload hydrate the last acknowledged revision', () => {
  const first = fixture();
  first.coordinator.open(target('thread-a'), emptyContent());
  first.coordinator.receive(stateEvent(document('thread-a', 3, 1)));
  const changed = content(1.5);
  first.coordinator.update(changed);
  first.scheduler.run();
  assert.deepEqual(first.writes[0], {
    cwd: '/repo/worktree',
    canvasId: 'thread-a',
    expectedRevision: 3,
    content: changed,
  });
  first.coordinator.receive(savedEvent(document('thread-a', 4, 1.5)));

  const afterReload = fixture();
  afterReload.coordinator.open(target('thread-a'), emptyContent());
  assert.deepEqual(afterReload.reads, [{ cwd: '/repo/worktree', canvasId: 'thread-a' }]);
  afterReload.coordinator.receive(stateEvent(document('thread-a', 4, 1.5)));
  assert.equal(afterReload.hydrated.at(-1)?.state.view.zoom, 1.5);
});

test('opening an identical target stays pending without starting a duplicate restore', () => {
  const harness = fixture();
  const first = harness.coordinator.open(target('thread-a'), emptyContent());
  const hydrateCount = harness.hydrated.length;
  const repeated = harness.coordinator.open(target('thread-a'), emptyContent());

  assert.equal(first, 'started');
  assert.equal(repeated, 'pending');
  assert.equal(harness.reads.length, 1);
  assert.equal(harness.hydrated.length, hydrateCount);

  harness.coordinator.receive(stateEvent(document('thread-a', 1, 1)));
  assert.equal(harness.coordinator.open(target('thread-a'), emptyContent()), 'ready');
  assert.equal(harness.reads.length, 1);
});

test('a late restore establishes revision without overwriting newer local edits', () => {
  const harness = fixture();
  harness.coordinator.open(target('thread-a'), emptyContent());
  const hydrateCount = harness.hydrated.length;
  const local = content(1.6);
  harness.coordinator.update(local);

  harness.coordinator.receive(stateEvent(document('thread-a', 4, 0.8)));
  assert.equal(harness.hydrated.length, hydrateCount);
  harness.scheduler.run();
  assert.deepEqual(harness.writes, [
    {
      cwd: '/repo/worktree',
      canvasId: 'thread-a',
      expectedRevision: 4,
      content: local,
    },
  ]);
});

test('read failures preserve edits and enable a non-destructive save', () => {
  const harness = fixture();
  harness.coordinator.open(target('thread-a'), emptyContent());
  const hydrateCount = harness.hydrated.length;
  const local = content(1.4);
  harness.coordinator.update(local);

  harness.coordinator.receive(errorEvent('read', 'could not read canvas'));
  harness.scheduler.run();

  assert.equal(harness.hydrated.length, hydrateCount);
  assert.deepEqual(harness.notices.at(-1), ['could not read canvas']);
  assert.deepEqual(harness.writes.at(-1), {
    cwd: '/repo/worktree',
    canvasId: 'thread-a',
    expectedRevision: 0,
    content: local,
  });
});

test('write failures retry local content without rereading or hydrating stale state', () => {
  const harness = fixture();
  harness.coordinator.open(target('thread-a'), emptyContent());
  harness.coordinator.receive(stateEvent(document('thread-a', 3, 1)));
  const hydrateCount = harness.hydrated.length;
  const local = content(1.7);
  harness.coordinator.update(local);
  harness.scheduler.run();
  harness.coordinator.receive(errorEvent('write', 'revision conflict', 5));
  harness.scheduler.run();

  assert.equal(harness.reads.length, 1);
  assert.equal(harness.hydrated.length, hydrateCount);
  assert.deepEqual(
    harness.writes.map((write) => write.expectedRevision),
    [3, 5],
  );
  assert.deepEqual(harness.writes.at(-1)?.content, local);
});

test('thread switches flush the previous canvas and ignore stale responses', () => {
  const harness = fixture();
  harness.coordinator.open(target('thread-a'), emptyContent());
  harness.coordinator.receive(stateEvent(null, 'thread-a'));
  harness.coordinator.update(content(1.2));
  harness.coordinator.open(target('thread-b'), content(1.2));

  assert.equal(harness.writes[0]?.canvasId, 'thread-a');
  assert.equal(harness.reads.at(-1)?.canvasId, 'thread-b');
  const hydrateCount = harness.hydrated.length;
  harness.coordinator.receive(stateEvent(document('thread-a', 2, 4)));
  assert.equal(harness.hydrated.length, hydrateCount);
  harness.coordinator.receive(stateEvent(document('thread-b', 1, 0.8)));
  assert.equal(harness.hydrated.at(-1)?.state.view.zoom, 0.8);
});

test('thread switches finish a newer edit queued behind an in-flight save', () => {
  const harness = fixture();
  harness.coordinator.open(target('thread-a'), emptyContent());
  harness.coordinator.receive(stateEvent(document('thread-a', 1, 1)));
  harness.coordinator.update(content(1.2));
  harness.scheduler.run();
  harness.coordinator.update(content(1.6));

  harness.coordinator.open(target('thread-b'), emptyContent());
  harness.coordinator.receive(savedEvent(document('thread-a', 2, 1.2)));

  assert.deepEqual(harness.writes, [
    {
      cwd: '/repo/worktree',
      canvasId: 'thread-a',
      expectedRevision: 1,
      content: content(1.2),
    },
    {
      cwd: '/repo/worktree',
      canvasId: 'thread-a',
      expectedRevision: 2,
      content: content(1.6),
    },
  ]);
});

test('an unsent draft uses one safe durable id and reopens independently', () => {
  assert.equal(canvasIdForSession(undefined), DRAFT_CANVAS_ID);
  assert.equal(canvasIdForSession(null), DRAFT_CANVAS_ID);
  assert.equal(canvasIdForSession(''), DRAFT_CANVAS_ID);
  assert.match(DRAFT_CANVAS_ID, /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

  const first = fixture();
  first.coordinator.open(target(DRAFT_CANVAS_ID), emptyContent());
  first.coordinator.receive(stateEvent(null, DRAFT_CANVAS_ID));
  first.coordinator.update(content(0.7));
  first.coordinator.flush();
  assert.equal(first.writes[0]?.canvasId, DRAFT_CANVAS_ID);

  const reopened = fixture();
  reopened.coordinator.open(target(DRAFT_CANVAS_ID), emptyContent());
  reopened.coordinator.receive(stateEvent(document(DRAFT_CANVAS_ID, 1, 0.7)));
  assert.equal(reopened.hydrated.at(-1)?.state.view.zoom, 0.7);
});

function fixture() {
  const reads: { cwd: string; canvasId: string }[] = [];
  const writes: Parameters<CanvasPersistenceTransport['write']>[0][] = [];
  const hydrated: HydratedStudioCanvas[] = [];
  const notices: string[][] = [];
  const scheduler = manualScheduler();
  const coordinator = new CanvasSaveCoordinator(
    {
      read: (cwd, canvasId) => reads.push({ cwd, canvasId }),
      write: (input) => writes.push(input),
    },
    (value) => hydrated.push(value),
    (value) => notices.push(value),
    scheduler.schedule,
  );
  return { coordinator, reads, writes, hydrated, notices, scheduler };
}

function manualScheduler() {
  let pending: (() => void) | null = null;
  return {
    schedule(callback: () => void) {
      pending = callback;
      return () => {
        if (pending === callback) pending = null;
      };
    },
    run() {
      const callback = pending;
      pending = null;
      callback?.();
    },
  };
}

function target(canvasId: string) {
  return { cwd: '/repo/worktree', projectKey: '/repo/live', canvasId };
}

function emptyContent(): CanvasDocumentContent {
  return serializeStudioCanvas(emptyStudioCanvasState()).content;
}

function content(zoom: number): CanvasDocumentContent {
  const value = document('fixture', 1, zoom);
  return {
    view: value.view,
    frames: value.frames,
    annotations: value.annotations,
    images: value.images,
  };
}

function document(threadId: string, revision: number, zoom: number): CanvasDocument {
  return {
    schemaVersion: 1,
    projectId: 'project-0123456789abcdef01234567',
    threadId,
    revision,
    updatedAt: '2026-07-30T12:00:00.000Z',
    view: { pan: { x: 10, y: -20 }, zoom },
    frames: [
      {
        id: 'frame-home',
        name: 'Home',
        source: { type: 'url', url: 'http://localhost:5173' },
        kind: 'route',
        viewport: { mode: 'desktop' },
        x: 40,
        y: 80,
      },
    ],
    annotations: [],
    images: [
      {
        id: 'image-placement',
        libraryId: 'canvas-library-image',
        tag: 'inspiration',
        x: 1200,
        y: 100,
        width: 320,
        height: 200,
      },
    ],
  };
}

function stateEvent(
  value: CanvasDocument | null,
  canvasId = value?.threadId ?? 'thread-a',
): Extract<ServerEvent, { type: 'design.canvas.state' }> {
  return {
    type: 'design.canvas.state',
    cwd: '/repo/worktree',
    canvasId,
    document: value,
    frames: value
      ? value.frames.map((frame) => ({ frameId: frame.id, url: frame.source.url }))
      : [],
    images: value
      ? [
          {
            libraryId: 'canvas-library-image',
            name: 'Reference',
            url: 'http://127.0.0.1:4123/canvas-image/reference.png',
          },
        ]
      : [],
  };
}

function savedEvent(value: CanvasDocument): Extract<ServerEvent, { type: 'design.canvas.saved' }> {
  return {
    type: 'design.canvas.saved',
    cwd: '/repo/worktree',
    canvasId: value.threadId,
    document: value,
  };
}

function errorEvent(
  operation: 'read' | 'write',
  message: string,
  actualRevision?: number,
): Extract<ServerEvent, { type: 'design.canvas.error' }> {
  return {
    type: 'design.canvas.error',
    cwd: '/repo/worktree',
    canvasId: 'thread-a',
    operation,
    message,
    ...(actualRevision === undefined ? {} : { actualRevision }),
  };
}
