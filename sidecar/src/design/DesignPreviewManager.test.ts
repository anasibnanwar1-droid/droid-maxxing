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
  writeFileSync(
    join(pageDir, 'dashboard.html'),
    '<link rel="stylesheet" href="styles.css"><link href=".env"><script type="module" src="app.js"></script><h1>Dashboard</h1>',
    'utf8',
  );
  mkdirSync(join(pageDir, 'assets'));
  writeFileSync(
    join(pageDir, 'styles.css'),
    '@font-face { font-family: Demo; src: url("assets/demo.woff2") } h1 { color: green; }',
    'utf8',
  );
  writeFileSync(join(pageDir, 'app.js'), 'import "./chunk.js";', 'utf8');
  writeFileSync(join(pageDir, 'chunk.js'), 'document.body.dataset.ready = "true";', 'utf8');
  writeFileSync(join(pageDir, 'assets', 'demo.woff2'), 'font', 'utf8');
  writeFileSync(join(pageDir, '.env'), 'SECRET=not-for-preview', 'utf8');
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
  const stylesheet = await fetch(new URL('styles.css', rendered.ok ? rendered.url : ''));
  assert.equal(stylesheet.status, 200);
  assert.match(await stylesheet.text(), /h1 \{ color: green; \}/);
  const chunk = await fetch(new URL('chunk.js', rendered.ok ? rendered.url : ''));
  assert.equal(chunk.status, 200);
  const font = await fetch(new URL('assets/demo.woff2', rendered.ok ? rendered.url : ''));
  assert.equal(font.status, 200);
  const unreferenced = await fetch(new URL('.env', rendered.ok ? rendered.url : ''));
  assert.equal(unreferenced.status, 404);

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
