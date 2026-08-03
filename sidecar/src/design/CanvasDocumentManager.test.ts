import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CanvasDocumentContent, ClientCommand, ServerEvent } from '../protocol.js';
import { CanvasDocumentManager } from './CanvasDocumentManager.js';

test('canvas commands reopen the same document through a linked worktree and new manager', async (t) => {
  const root = temporaryRoot(t, 'droidex-canvas-manager-worktree-');
  const live = join(root, 'live');
  const worktree = join(root, 'worktree');
  const baseDir = join(root, 'app-data');
  mkdirSync(live);
  git(live, ['init', '-b', 'main']);
  git(live, ['config', 'user.email', 'canvas-manager@example.com']);
  git(live, ['config', 'user.name', 'Canvas Manager']);
  writeFileSync(join(live, 'README.md'), '# Canvas\n', 'utf8');
  git(live, ['add', 'README.md']);
  git(live, ['commit', '-m', 'initial']);
  git(live, ['worktree', 'add', '-b', 'canvas-test', worktree]);

  const writtenEvents: ServerEvent[] = [];
  const first = manager(writtenEvents, baseDir);
  first.write(writeCommand(live, 'thread-one', 0, content(1.2)));
  assert.equal(savedEvents(writtenEvents).at(-1)?.document.revision, 1);

  const reopenedEvents: ServerEvent[] = [];
  const afterReload = manager(reopenedEvents, baseDir);
  await afterReload.read({ type: 'design.canvas.read', cwd: worktree, canvasId: 'thread-one' });
  const reopened = stateEvents(reopenedEvents).at(-1);
  assert.equal(reopened?.document?.view.zoom, 1.2);
  assert.equal(reopened?.frames[0]?.url, 'http://localhost:5173');
  assert.equal(reopened?.document?.threadId, 'thread-one');
});

test('canvas commands isolate threads, resolve durable image ids, and report revision conflicts', async (t) => {
  const root = temporaryRoot(t, 'droidex-canvas-manager-isolation-');
  const cwd = join(root, 'project');
  const baseDir = join(root, 'app-data');
  mkdirSync(cwd);
  const events: ServerEvent[] = [];
  const documents = manager(events, baseDir);
  documents.write(writeCommand(cwd, 'thread-a', 0, content(0.8)));
  documents.write(writeCommand(cwd, 'thread-b', 0, content(1.6)));
  await documents.read({ type: 'design.canvas.read', cwd, canvasId: 'thread-a' });
  await documents.read({ type: 'design.canvas.read', cwd, canvasId: 'thread-b' });

  const states = stateEvents(events);
  assert.deepEqual(
    states.slice(-2).map((event) => [event.canvasId, event.document?.view.zoom]),
    [
      ['thread-a', 0.8],
      ['thread-b', 1.6],
    ],
  );
  assert.equal(states.at(-1)?.images[0]?.libraryId, 'canvas-library-image');
  assert.equal(states.at(-1)?.images[0]?.url, 'http://127.0.0.1:43210/canvas-image/reference.png');

  documents.write(writeCommand(cwd, 'thread-a', 0, content(2)));
  const conflict = events
    .filter(
      (event): event is Extract<ServerEvent, { type: 'design.canvas.error' }> =>
        event.type === 'design.canvas.error',
    )
    .at(-1);
  assert.equal(conflict?.operation, 'write');
  assert.equal(conflict?.actualRevision, 1);
  assert.match(conflict?.message ?? '', /Reload the canvas and retry/);
});

function manager(events: ServerEvent[], baseDir: string): CanvasDocumentManager {
  return new CanvasDocumentManager({
    baseDir,
    emit: (event) => events.push(event),
    resolveFrameSource: async (_cwd, source) =>
      source.type === 'url'
        ? { url: source.url }
        : { error: `Unsupported test source ${source.type}` },
    resolveImageAsset: async (_cwd, libraryId) =>
      libraryId === 'canvas-library-image'
        ? {
            name: 'Reference board',
            url: 'http://127.0.0.1:43210/canvas-image/reference.png',
          }
        : { error: 'Missing test image.' },
  });
}

function writeCommand(
  cwd: string,
  canvasId: string,
  expectedRevision: number,
  value: CanvasDocumentContent,
): Extract<ClientCommand, { type: 'design.canvas.write' }> {
  return {
    type: 'design.canvas.write',
    cwd,
    canvasId,
    expectedRevision,
    content: value,
  };
}

function content(zoom: number): CanvasDocumentContent {
  return {
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
        tag: 'moodboard',
        x: 1200,
        y: 100,
        width: 320,
        height: 200,
      },
    ],
  };
}

function savedEvents(
  events: ServerEvent[],
): Extract<ServerEvent, { type: 'design.canvas.saved' }>[] {
  return events.filter(
    (event): event is Extract<ServerEvent, { type: 'design.canvas.saved' }> =>
      event.type === 'design.canvas.saved',
  );
}

function stateEvents(
  events: ServerEvent[],
): Extract<ServerEvent, { type: 'design.canvas.state' }>[] {
  return events.filter(
    (event): event is Extract<ServerEvent, { type: 'design.canvas.state' }> =>
      event.type === 'design.canvas.state',
  );
}

function temporaryRoot(t: test.TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 10_000 });
}
