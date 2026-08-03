import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanvasDocument, CanvasDocumentContent, ServerEvent } from '../../types/bridge';
import { emptyStudioCanvasState } from './StudioCanvasContext';
import type { CanvasPersistenceTransport } from './studioCanvasPersistence';
import { StudioCanvasPersistenceOwner } from './studioCanvasPersistenceOwner';

test('detach before initial restore never writes the empty UI state', () => {
  const harness = fixture();
  const detach = harness.owner.attach({ onHydrate: () => undefined, onNotice: () => undefined });
  harness.owner.open(target(), content(1));

  detach();
  harness.emit(stateEvent(document(4, 1.4)));

  assert.equal(harness.writes.length, 0);
  harness.owner.destroy();
});

test('remount keeps one writer and newer edits win across an in-flight save', () => {
  const harness = fixture();
  const firstHydrations: number[] = [];
  const detach = harness.owner.attach({
    onHydrate: (hydrated) => firstHydrations.push(hydrated.state.view.zoom),
    onNotice: () => undefined,
  });
  harness.owner.open(target(), content(1));
  harness.emit(stateEvent(document(1, 1)));
  harness.owner.update(studio(1.2));
  harness.runScheduled();
  harness.owner.update(studio(1.6));
  detach();

  const secondHydrations: number[] = [];
  harness.owner.attach({
    onHydrate: (hydrated) => secondHydrations.push(hydrated.state.view.zoom),
    onNotice: () => undefined,
  });
  assert.equal(harness.owner.open(target(), content(1)), 'ready');
  harness.owner.update(studio(2));

  harness.emit(savedEvent(document(2, 1.2)));
  harness.emit(stateEvent(document(2, 1.2)));
  harness.runScheduled();
  harness.emit(savedEvent(document(3, 2)));
  harness.emit(stateEvent(document(3, 2)));

  assert.deepEqual(
    harness.writes.map((write) => ({
      revision: write.expectedRevision,
      zoom: write.content.view.zoom,
    })),
    [
      { revision: 1, zoom: 1.2 },
      { revision: 2, zoom: 2 },
    ],
  );
  assert.deepEqual(firstHydrations, [1, 1]);
  assert.deepEqual(secondHydrations, [2]);
  assert.equal(harness.subscriptionCount, 1);
  harness.owner.destroy();
});

test('target hydration cannot turn the destination empty state into a write', () => {
  const harness = fixture();
  const hydrated: number[] = [];
  harness.owner.attach({
    onHydrate: (value) => hydrated.push(value.state.view.zoom),
    onNotice: () => undefined,
  });
  harness.owner.open(target('thread-a'), content(1));
  harness.owner.update(studio(1));
  harness.emit(stateEvent(document(1, 1), 'thread-a'));
  harness.owner.update(studio(1));

  harness.owner.open(target('thread-b'), content(1));
  harness.owner.update(studio(1));
  harness.emit(stateEvent(document(7, 1.8, 'thread-b'), 'thread-b'));
  harness.owner.update(studio(1.8));

  assert.deepEqual(hydrated, [1, 1, 1, 1.8]);
  assert.equal(harness.writes.length, 0);
  harness.owner.destroy();
});

test('an edit made during delayed restore survives a target switch and read retry', () => {
  const harness = fixture();
  harness.owner.attach({ onHydrate: () => undefined, onNotice: () => undefined });
  harness.owner.open(target('thread-a'), content(1));
  harness.owner.update(studio(1));
  harness.owner.update(studio(1.6));
  harness.owner.open(target('thread-b'), content(1));

  harness.emit(readErrorEvent('thread-a'));
  harness.runScheduled();
  harness.emit(stateEvent(document(5, 1, 'thread-a'), 'thread-a'));

  assert.deepEqual(
    harness.reads.map((read) => read.canvasId),
    ['thread-a', 'thread-b', 'thread-a'],
  );
  assert.deepEqual(harness.writes.at(-1), {
    cwd: '/repo/design',
    canvasId: 'thread-a',
    expectedRevision: 5,
    content: content(1.6),
  });
  harness.owner.destroy();
});

test('returning to a target with an in-flight save rehydrates its restored edit', () => {
  const harness = fixture();
  const hydrated: number[] = [];
  harness.owner.attach({
    onHydrate: (value) => hydrated.push(value.state.view.zoom),
    onNotice: () => undefined,
  });
  harness.owner.open(target('thread-a'), content(1));
  harness.emit(stateEvent(document(1, 1), 'thread-a'));
  harness.owner.update(studio(1.6));

  harness.owner.open(target('thread-b'), content(1));
  harness.owner.open(target('thread-a'), content(1));
  harness.emit(stateEvent(document(1, 1), 'thread-a'));
  harness.emit(savedEvent(document(2, 1.6)));

  assert.deepEqual(
    harness.reads.map((read) => read.canvasId),
    ['thread-a', 'thread-b', 'thread-a', 'thread-a'],
  );
  harness.emit(stateEvent(document(2, 1.6), 'thread-a'));
  assert.equal(hydrated.at(-1), 1.6);
  harness.owner.destroy();
});

test('bridge reconnect retries only an outstanding canvas hydration', () => {
  const harness = fixture();
  harness.owner.attach({ onHydrate: () => undefined, onNotice: () => undefined });
  harness.owner.open(target('thread-a'), content(1));

  harness.reconnect();
  assert.deepEqual(
    harness.reads.map((read) => read.canvasId),
    ['thread-a', 'thread-a'],
  );

  harness.emit(stateEvent(document(1, 1), 'thread-a'));
  harness.reconnect();
  assert.equal(harness.reads.length, 2);
  harness.owner.destroy();
});

test('rapid canvas updates serialize once after the persistence boundary', () => {
  const harness = fixture();
  const serialized: number[] = [];
  harness.owner.attach({
    onHydrate: () => undefined,
    onNotice: () => undefined,
    onSerialize: () => serialized.push(1),
  });
  harness.owner.open(target(), content(1));
  harness.emit(stateEvent(document(1, 1)));

  harness.owner.update(studio(1.2));
  harness.owner.update(studio(1.4));
  harness.owner.update(studio(1.6));

  assert.equal(serialized.length, 0);
  assert.equal(harness.writes.length, 0);
  harness.runScheduled();
  assert.equal(serialized.length, 1);
  assert.equal(harness.writes.at(-1)?.content.view.zoom, 1.6);
  harness.owner.destroy();
});

function fixture() {
  const reads: { cwd: string; canvasId: string }[] = [];
  const writes: Parameters<CanvasPersistenceTransport['write']>[0][] = [];
  const listeners = new Set<(event: ServerEvent) => void>();
  const openListeners = new Set<() => void>();
  const scheduled: (() => void)[] = [];
  const owner = new StudioCanvasPersistenceOwner(
    {
      read: (cwd, canvasId) => reads.push({ cwd, canvasId }),
      write: (input) => writes.push(input),
    },
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    (callback) => {
      scheduled.push(callback);
      return () => {
        const index = scheduled.indexOf(callback);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
    (listener) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
  );
  return {
    owner,
    reads,
    writes,
    get subscriptionCount() {
      return listeners.size;
    },
    emit: (event: ServerEvent) => listeners.forEach((listener) => listener(event)),
    reconnect: () => openListeners.forEach((listener) => listener()),
    runScheduled: () => {
      while (scheduled.length > 0) scheduled.shift()?.();
    },
  };
}

function target(canvasId = 'thread-a') {
  return { cwd: '/repo/design', projectKey: '/repo', canvasId };
}

function content(zoom: number): CanvasDocumentContent {
  return {
    view: { pan: { x: 0, y: 0 }, zoom },
    frames: [],
    annotations: [],
    images: [],
  };
}

function studio(zoom: number) {
  return {
    ...emptyStudioCanvasState(),
    view: { pan: { x: 0, y: 0 }, zoom },
  };
}

function document(revision: number, zoom: number, threadId = 'thread-a'): CanvasDocument {
  return {
    schemaVersion: 1,
    projectId: 'project-0123456789abcdef01234567',
    threadId,
    revision,
    updatedAt: '2026-08-01T12:00:00.000Z',
    ...content(zoom),
  };
}

function stateEvent(value: CanvasDocument, canvasId = 'thread-a'): ServerEvent {
  return {
    type: 'design.canvas.state',
    cwd: '/repo/design',
    canvasId,
    document: value,
    frames: [],
    images: [],
  };
}

function savedEvent(value: CanvasDocument): ServerEvent {
  return {
    type: 'design.canvas.saved',
    cwd: '/repo/design',
    canvasId: 'thread-a',
    document: value,
  };
}

function readErrorEvent(canvasId: string): ServerEvent {
  return {
    type: 'design.canvas.error',
    cwd: '/repo/design',
    canvasId,
    operation: 'read',
    message: 'restore unavailable',
  };
}
