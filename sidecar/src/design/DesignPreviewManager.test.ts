import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ServerEvent } from '../protocol.js';
import { DesignPreviewManager } from './DesignPreviewManager.js';
import { PreviewServer } from './previewServer.js';
import { importReferenceImage } from './referenceLibrary.js';

test('workspace previews emit and later resolve an honest canonical source descriptor', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-preview-source-'));
  const pageDir = join(cwd, 'preview');
  mkdirSync(pageDir);
  writeFileSync(join(pageDir, 'dashboard.html'), '<h1>Dashboard</h1>', 'utf8');
  const server = new PreviewServer();
  t.after(async () => {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const events: ServerEvent[] = [];
  const previews = new DesignPreviewManager((event) => events.push(event), server);

  const rendered = await previews.render({ cwd, path: 'preview/dashboard.html' });
  assert.equal(rendered.ok, true);
  const event = events.find(
    (candidate): candidate is Extract<ServerEvent, { type: 'design.preview' }> =>
      candidate.type === 'design.preview',
  );
  assert.deepEqual(event?.source, {
    type: 'workspace-html',
    relativePath: 'preview/dashboard.html',
  });

  const beforeResolve = events.length;
  const resolved = await previews.resolveSource(cwd, {
    type: 'workspace-html',
    relativePath: 'preview/dashboard.html',
  });
  assert.match(resolved.url ?? '', /^http:\/\/127\.0\.0\.1:/);
  assert.equal(events.length, beforeResolve, 'hydration resolution does not add a duplicate frame');
});

test('library images resolve to stable confined HTTP assets without exposing file paths', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'droidex-preview-image-'));
  const cwd = join(root, 'project');
  const baseDir = join(root, 'app-data');
  mkdirSync(cwd);
  importReferenceImage({
    cwd,
    baseDir,
    id: 'canvas-library-image',
    name: 'Reference board',
    category: 'inspiration',
    dataUrl: 'data:image/png;base64,YWJj',
  });
  const server = new PreviewServer();
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const previews = new DesignPreviewManager(() => undefined, server, baseDir);

  const first = await previews.resolveImageAsset(cwd, 'canvas-library-image');
  const second = await previews.resolveImageAsset(cwd, 'canvas-library-image');

  assert.match(first.url ?? '', /^http:\/\/127\.0\.0\.1:/);
  assert.equal(second.url, first.url);
  assert.equal(first.url?.includes(root), false);
  const response = await fetch(first.url ?? '');
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from('abc'));
});
