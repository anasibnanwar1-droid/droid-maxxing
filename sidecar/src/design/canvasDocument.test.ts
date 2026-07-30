import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  CanvasDocumentCorruptError,
  CanvasDocumentRevisionConflictError,
  CanvasDocumentValidationError,
  canvasDocumentPath,
  readCanvasDocument,
  writeCanvasDocument,
} from './canvasDocument.js';
import {
  MAX_ANNOTATION_POINTS,
  MAX_TOTAL_ANNOTATION_POINTS,
  MAX_CANVAS_ANNOTATIONS,
  MAX_CANVAS_FRAMES,
  MAX_CANVAS_IMAGES,
  type CanvasDocumentContent,
} from './canvasDocumentSchema.js';
import { resolveDesignProjectIdentity } from './projectIdentity.js';

const NOW = new Date('2026-07-30T12:00:00.000Z');

test('git root and linked worktree share one canonical canvas identity', (t) => {
  const root = temporaryRoot('droidex-canvas-worktree-');
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const live = join(root, 'live');
  const worktree = join(root, 'design-worktree');
  const data = join(root, 'app-data');
  mkdirSync(live);
  git(live, ['init', '-b', 'main']);
  git(live, ['config', 'user.email', 'canvas-test@example.com']);
  git(live, ['config', 'user.name', 'Canvas Test']);
  writeFileSync(join(live, 'README.md'), '# Product\n', 'utf8');
  git(live, ['add', 'README.md']);
  git(live, ['commit', '-m', 'initial']);
  git(live, ['worktree', 'add', '-b', 'design-test', worktree]);

  const liveIdentity = resolveDesignProjectIdentity(live);
  const worktreeIdentity = resolveDesignProjectIdentity(worktree);
  assert.equal(liveIdentity.kind, 'git');
  assert.deepEqual(worktreeIdentity, liveIdentity);
  assert.equal(
    canvasDocumentPath({ cwd: live, threadId: 'thread-1', baseDir: data }),
    canvasDocumentPath({ cwd: worktree, threadId: 'thread-1', baseDir: data }),
  );

  const saved = writeCanvasDocument({
    cwd: live,
    threadId: 'thread-1',
    expectedRevision: 0,
    content: canvasContent(),
    baseDir: data,
    now: () => NOW,
  });
  assert.deepEqual(
    readCanvasDocument({ cwd: worktree, threadId: 'thread-1', baseDir: data }),
    saved,
  );
});

test('canvas documents round-trip through atomic revisioned writes without ephemeral data', (t) => {
  const fixture = projectFixture(t, 'droidex-canvas-roundtrip-');
  const initial = writeCanvasDocument({
    ...fixture,
    threadId: 'session:one',
    expectedRevision: 0,
    content: canvasContent(),
    now: () => NOW,
  });
  assert.equal(initial.schemaVersion, 1);
  assert.equal(initial.revision, 1);
  assert.equal(initial.updatedAt, NOW.toISOString());
  assert.deepEqual(readCanvasDocument({ ...fixture, threadId: 'session:one' }), initial);

  const updatedContent: CanvasDocumentContent = {
    ...canvasContent(),
    view: { pan: { x: 200, y: -40 }, zoom: 0.8 },
    frames: canvasContent().frames.map((frame) => ({ ...frame, x: frame.x + 64 })),
  };
  const updated = writeCanvasDocument({
    ...fixture,
    threadId: 'session:one',
    expectedRevision: 1,
    content: updatedContent,
    now: () => new Date('2026-07-30T12:01:00.000Z'),
  });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.view, updatedContent.view);

  const file = canvasDocumentPath({ ...fixture, threadId: 'session:one' });
  const stored = readFileSync(file, 'utf8');
  assert.doesNotMatch(stored, /data:image|base64|selectedFrameIds|interactingFrameId|status/);
  assert.deepEqual(readdirSync(dirname(file)), [file.split('/').at(-1)]);
});

test('writes reject stale expected revisions with the actual revision', (t) => {
  const fixture = projectFixture(t, 'droidex-canvas-conflict-');
  writeCanvasDocument({
    ...fixture,
    threadId: 'session-conflict',
    expectedRevision: 0,
    content: canvasContent(),
  });

  assert.throws(
    () =>
      writeCanvasDocument({
        ...fixture,
        threadId: 'session-conflict',
        expectedRevision: 0,
        content: canvasContent(),
      }),
    (error: unknown) => {
      assert.ok(error instanceof CanvasDocumentRevisionConflictError);
      assert.equal(error.expectedRevision, 0);
      assert.equal(error.actualRevision, 1);
      assert.match(error.message, /Reload the canvas and retry/);
      return true;
    },
  );
});

test('reads fail actionably for corrupt JSON and unsupported schema versions', (t) => {
  const fixture = projectFixture(t, 'droidex-canvas-corrupt-');
  const malformedPath = canvasDocumentPath({ ...fixture, threadId: 'malformed' });
  mkdirSync(dirname(malformedPath), { recursive: true });
  writeFileSync(malformedPath, '{not json', 'utf8');
  assert.throws(
    () => readCanvasDocument({ ...fixture, threadId: 'malformed' }),
    (error: unknown) => {
      assert.ok(error instanceof CanvasDocumentCorruptError);
      assert.match(error.message, /invalid JSON/);
      assert.match(error.message, /Delete that file to reset/);
      return true;
    },
  );

  const valid = writeCanvasDocument({
    ...fixture,
    threadId: 'future-schema',
    expectedRevision: 0,
    content: canvasContent(),
    now: () => NOW,
  });
  const futurePath = canvasDocumentPath({ ...fixture, threadId: 'future-schema' });
  writeFileSync(futurePath, JSON.stringify({ ...valid, schemaVersion: 2 }), 'utf8');
  assert.throws(
    () => readCanvasDocument({ ...fixture, threadId: 'future-schema' }),
    (error: unknown) => {
      assert.ok(error instanceof CanvasDocumentCorruptError);
      assert.match(error.message, /schemaVersion/);
      return true;
    },
  );
});

test('strict schema enforces frame, annotation, point, and image caps', (t) => {
  const fixture = projectFixture(t, 'droidex-canvas-caps-');
  const base = canvasContent();
  const frame = base.frames[0];
  const annotation = base.annotations[0];
  const image = base.images[0];
  assert.ok(frame && annotation && image);

  assertInvalid(fixture, {
    ...base,
    frames: Array.from({ length: MAX_CANVAS_FRAMES + 1 }, (_, index) => ({
      ...frame,
      id: `frame-${String(index)}`,
    })),
  });
  assertInvalid(fixture, {
    ...base,
    annotations: Array.from({ length: MAX_CANVAS_ANNOTATIONS + 1 }, (_, index) => ({
      ...annotation,
      id: `annotation-${String(index)}`,
    })),
  });
  assertInvalid(fixture, {
    ...base,
    annotations: [
      {
        ...annotation,
        kind: 'pencil',
        points: Array.from({ length: MAX_ANNOTATION_POINTS + 1 }, (_, index) => ({
          x: index,
          y: index,
        })),
      },
    ],
  });
  const pointsPerAnnotation = Math.ceil(MAX_TOTAL_ANNOTATION_POINTS / 5);
  assertInvalid(fixture, {
    ...base,
    annotations: Array.from({ length: 5 }, (_, index) => ({
      ...annotation,
      id: `annotation-total-${String(index)}`,
      kind: 'pencil',
      points: Array.from({ length: pointsPerAnnotation }, (_, pointIndex) => ({
        x: pointIndex,
        y: index,
      })),
    })),
  });
  assertInvalid(fixture, {
    ...base,
    images: Array.from({ length: MAX_CANVAS_IMAGES + 1 }, (_, index) => ({
      ...image,
      id: `image-${String(index)}`,
    })),
  });
});

test('schema rejects base64, runtime state, duplicate ids, and missing frame anchors', (t) => {
  const fixture = projectFixture(t, 'droidex-canvas-strict-');
  const base = canvasContent();
  const frame = base.frames[0];
  const image = base.images[0];
  const annotation = base.annotations[0];
  assert.ok(frame && image && annotation);

  assertInvalid(fixture, {
    ...base,
    frames: [{ ...frame, status: 'ready', runtimeUrl: 'http://127.0.0.1:9999/preview/' }],
    images: [{ ...image, src: 'data:image/png;base64,YWJj' }],
    selectedFrameIds: ['frame-home'],
  } as unknown as CanvasDocumentContent);
  assertInvalid(fixture, {
    ...base,
    frames: [frame, { ...frame }],
  });
  assertInvalid(fixture, {
    ...base,
    annotations: [{ ...annotation, frameId: 'frame-missing' }],
  });
  assertInvalid(fixture, {
    ...base,
    frames: [{ ...frame, source: { type: 'url', url: 'data:text/html;base64,YWJj' } }],
  } as CanvasDocumentContent);
});

test('projects and threads remain isolated even when thread ids match', (t) => {
  const root = temporaryRoot('droidex-canvas-isolation-');
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const projectA = join(root, 'project-a');
  const projectB = join(root, 'project-b');
  const baseDir = join(root, 'app-data');
  mkdirSync(projectA);
  mkdirSync(projectB);

  const first = writeCanvasDocument({
    cwd: projectA,
    threadId: 'shared-thread',
    expectedRevision: 0,
    content: canvasContent(1),
    baseDir,
  });
  const second = writeCanvasDocument({
    cwd: projectA,
    threadId: 'other-thread',
    expectedRevision: 0,
    content: canvasContent(2),
    baseDir,
  });
  const third = writeCanvasDocument({
    cwd: projectB,
    threadId: 'shared-thread',
    expectedRevision: 0,
    content: canvasContent(3),
    baseDir,
  });

  assert.equal(
    readCanvasDocument({ cwd: projectA, threadId: 'shared-thread', baseDir })?.view.zoom,
    1,
  );
  assert.equal(
    readCanvasDocument({ cwd: projectA, threadId: 'other-thread', baseDir })?.view.zoom,
    2,
  );
  assert.equal(
    readCanvasDocument({ cwd: projectB, threadId: 'shared-thread', baseDir })?.view.zoom,
    3,
  );
  assert.notEqual(first.projectId, third.projectId);
  assert.notEqual(first.threadId, second.threadId);
  assert.notEqual(
    canvasDocumentPath({ cwd: projectA, threadId: 'shared-thread', baseDir }),
    canvasDocumentPath({ cwd: projectB, threadId: 'shared-thread', baseDir }),
  );
});

function canvasContent(zoom = 1): CanvasDocumentContent {
  return {
    view: { pan: { x: 12, y: -8 }, zoom },
    frames: [
      {
        id: 'frame-home',
        name: 'Home',
        source: { type: 'workspace-html', relativePath: '.droidex/prototypes/home.html' },
        kind: 'prototype',
        viewport: { mode: 'desktop', width: 1440, height: 900 },
        x: 40,
        y: 80,
      },
    ],
    annotations: [
      {
        id: 'annotation-measure',
        kind: 'measure',
        points: [
          { x: 20, y: 30 },
          { x: 180, y: 30 },
        ],
        color: 'blue',
        fill: 'none',
        strokeWidth: 2,
        frameId: 'frame-home',
      },
    ],
    images: [
      {
        id: 'image-placement',
        libraryId: 'canvas-library-image',
        tag: 'reference',
        x: 1800,
        y: 80,
        width: 420,
        height: 280,
      },
    ],
  };
}

function projectFixture(t: test.TestContext, prefix: string): { cwd: string; baseDir: string } {
  const root = temporaryRoot(prefix);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  return { cwd, baseDir: join(root, 'app-data') };
}

function assertInvalid(
  fixture: { cwd: string; baseDir: string },
  content: CanvasDocumentContent,
): void {
  assert.throws(
    () =>
      writeCanvasDocument({
        ...fixture,
        threadId: 'invalid-canvas',
        expectedRevision: 0,
        content,
      }),
    CanvasDocumentValidationError,
  );
}

function temporaryRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 10_000 });
}
