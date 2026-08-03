import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    join(pageDir, 'dashboard.htm'),
    '<link rel="stylesheet" href="styles.css"><link href=".env"><link href="secrets/data.json"><script type="module" src="app.mjs"></script><img srcset="assets/card.png 1x, assets/card@2x.png 2x" poster="assets/poster.webp"><h1>Dashboard</h1>',
    'utf8',
  );
  mkdirSync(join(pageDir, 'assets'));
  writeFileSync(
    join(pageDir, 'styles.css'),
    '@font-face { font-family: Demo; src: url("assets/demo.woff2") } h1 { color: green; }',
    'utf8',
  );
  writeFileSync(
    join(pageDir, 'app.mjs'),
    'import "./chunk.mjs"; new URL("./assets/icon.svg", import.meta.url);',
    'utf8',
  );
  writeFileSync(join(pageDir, 'chunk.mjs'), 'document.body.dataset.ready = "true";', 'utf8');
  writeFileSync(join(pageDir, 'assets', 'demo.woff2'), 'font', 'utf8');
  writeFileSync(join(pageDir, 'assets', 'card.png'), 'card', 'utf8');
  writeFileSync(join(pageDir, 'assets', 'card@2x.png'), 'card-2x', 'utf8');
  writeFileSync(join(pageDir, 'assets', 'poster.webp'), 'poster', 'utf8');
  writeFileSync(join(pageDir, 'assets', 'icon.svg'), '<svg/>', 'utf8');
  mkdirSync(join(pageDir, 'secrets'));
  writeFileSync(join(pageDir, 'secrets', 'data.json'), '{"token":"not-for-preview"}', 'utf8');
  writeFileSync(join(pageDir, '.env'), 'SECRET=not-for-preview', 'utf8');
  const server = new PreviewServer();
  t.after(async () => {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const events: ServerEvent[] = [];
  const previews = new DesignPreviewManager((event) => events.push(event), server);

  const rendered = await previews.render({ cwd, path: 'preview/dashboard.htm' });
  assert.equal(rendered.ok, true);
  const event = events.find(
    (candidate): candidate is Extract<ServerEvent, { type: 'design.preview' }> =>
      candidate.type === 'design.preview',
  );
  assert.deepEqual(event?.source, {
    type: 'workspace-html',
    relativePath: 'preview/dashboard.htm',
  });
  const document = await fetch(rendered.ok ? rendered.url : '');
  assert.match(document.headers.get('content-type') ?? '', /^text\/html/);
  const stylesheet = await fetch(new URL('styles.css', rendered.ok ? rendered.url : ''));
  assert.equal(stylesheet.status, 200);
  assert.match(await stylesheet.text(), /h1 \{ color: green; \}/);
  const module = await fetch(new URL('app.mjs', rendered.ok ? rendered.url : ''));
  assert.match(module.headers.get('content-type') ?? '', /^application\/javascript/);
  const chunk = await fetch(new URL('chunk.mjs', rendered.ok ? rendered.url : ''));
  assert.equal(chunk.status, 200);
  const font = await fetch(new URL('assets/demo.woff2', rendered.ok ? rendered.url : ''));
  assert.equal(font.status, 200);
  for (const asset of [
    'assets/card.png',
    'assets/card@2x.png',
    'assets/poster.webp',
    'assets/icon.svg',
  ]) {
    assert.equal((await fetch(new URL(asset, rendered.ok ? rendered.url : ''))).status, 200);
  }
  const unreferenced = await fetch(new URL('.env', rendered.ok ? rendered.url : ''));
  assert.equal(unreferenced.status, 404);
  const nestedSecret = await fetch(new URL('secrets/data.json', rendered.ok ? rendered.url : ''));
  assert.equal(nestedSecret.status, 404);

  const beforeResolve = events.length;
  const resolved = await previews.resolveSource(cwd, {
    type: 'workspace-html',
    relativePath: 'preview/dashboard.htm',
  });
  assert.match(resolved.url ?? '', /^http:\/\/127\.0\.0\.1:/);
  assert.equal(events.length, beforeResolve, 'hydration resolution does not add a duplicate frame');
});

test('workspace previews in one directory keep independent registrations', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-preview-variants-'));
  const variants = join(cwd, 'variants');
  mkdirSync(variants);
  writeFileSync(join(variants, 'a.html'), '<h1>Variant A</h1>', 'utf8');
  writeFileSync(join(variants, 'b.html'), '<h1>Variant B</h1>', 'utf8');
  const server = new PreviewServer();
  t.after(async () => {
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  const previews = new DesignPreviewManager(() => undefined, server);

  const first = await previews.render({ cwd, path: 'variants/a.html' });
  const second = await previews.render({ cwd, path: 'variants/b.html' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.url, second.url);
  assert.match(await (await fetch(first.url)).text(), /Variant A/);
  assert.match(await (await fetch(second.url)).text(), /Variant B/);
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

test('generated preview storage retries failed setup and is removed on close', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'droidex-generated-preview-'));
  const prototypeDir = join(cwd, '.droidex', 'prototypes');
  const generatedRoot = join(cwd, 'generated');
  mkdirSync(prototypeDir, { recursive: true });
  writeFileSync(join(prototypeDir, 'card.html'), '<h1>Card</h1>', 'utf8');
  const server = new PreviewServer();
  let createAttempts = 0;
  const previews = new DesignPreviewManager(() => undefined, server, undefined, {
    createRoot: async () => {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error('temporary storage unavailable');
      mkdirSync(generatedRoot);
      return generatedRoot;
    },
    removeRoot: async (root) => {
      rmSync(root, { recursive: true, force: true });
    },
  });
  t.after(async () => {
    await previews.close();
    await server.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  const failed = await previews.render({ cwd, prototypeId: 'card' });
  assert.deepEqual(failed, { ok: false, error: 'temporary storage unavailable' });

  const rendered = await previews.render({ cwd, prototypeId: 'card' });
  assert.equal(rendered.ok, true);
  assert.equal(createAttempts, 2);
  assert.equal(existsSync(generatedRoot), true);

  await previews.close();
  assert.equal(existsSync(generatedRoot), false);
});
