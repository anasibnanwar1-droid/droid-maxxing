import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { CanvasFrameSource, ServerEvent } from '../protocol.js';
import { renderBrandBook } from './brandBook.js';
import { buildComponentPreview, componentPreviewLabel } from './componentPreview.js';
import { referenceImageDir } from './designPaths.js';
import { readDnaState } from './dnaFiles.js';
import type { PreviewServer } from './previewServer.js';
import { resolveDesignProjectIdentity } from './projectIdentity.js';
import { listPrototypes } from './prototypes.js';
import { getLibraryItem } from './referenceLibrary.js';

interface PreviewResult {
  ok: true;
  url: string;
  name: string;
  source: CanvasFrameSource;
}

interface PreviewFailure {
  ok: false;
  error: string;
}

export class DesignPreviewManager {
  constructor(
    private readonly emit: (event: ServerEvent) => void,
    private readonly previewServer: PreviewServer,
    private readonly baseDir?: string,
  ) {}

  async renderBrandBook(cwd: string, shouldEmit = true): Promise<PreviewResult> {
    const state = readDnaState(cwd);
    if (!state.tokens) {
      throw new Error(
        'No design tokens yet — run the DNA intake (interview or scan) before generating a brand book.',
      );
    }
    const html = renderBrandBook({
      cwd,
      tokens: state.tokens,
      designMd: state.design.content,
      motionMd: state.motion.content,
    });
    const id = `brand-${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`;
    const dir = await generatedPreviewDirectory(id);
    await writeFile(join(dir, 'index.html'), html, 'utf8');
    return this.serve({
      cwd,
      id,
      dir,
      entry: 'index.html',
      assets: ['index.html'],
      label: 'Brand guidelines',
      source: { type: 'brand-book' },
      shouldEmit,
    });
  }

  async renderComponent(
    input: {
      cwd: string;
      file: string;
      name: string;
      exportKind: 'default' | 'named';
    },
    shouldEmit = true,
  ): Promise<PreviewResult> {
    const built = await buildComponentPreview(input);
    if (built.error) throw new Error(built.error);
    return this.serve({
      cwd: input.cwd,
      id: built.id,
      dir: built.dir,
      entry: 'index.html',
      assets: built.assets ?? ['index.html'],
      label: componentPreviewLabel(input.name),
      kind: 'component',
      source: {
        type: 'component',
        file: input.file,
        name: input.name,
        exportKind: input.exportKind,
      },
      shouldEmit,
    });
  }

  async render(input: {
    cwd: string;
    path?: string;
    prototypeId?: string;
    name?: string;
    shouldEmit?: boolean;
  }): Promise<PreviewResult | PreviewFailure> {
    const { cwd } = input;
    if (!cwd) return { ok: false, error: 'No workspace folder for this session.' };
    const name = input.name?.trim();
    const requestedName = name === '' ? undefined : name;
    try {
      if (input.prototypeId) {
        return await this.renderPrototype(cwd, input.prototypeId, requestedName, input.shouldEmit);
      }
      if (input.path?.trim()) {
        return await this.renderWorkspaceHtml(
          cwd,
          input.path.trim(),
          requestedName,
          input.shouldEmit,
        );
      }
      return { ok: false, error: 'Pass a path or a prototypeId to preview.' };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not read the file.',
      };
    }
  }

  private async renderPrototype(
    cwd: string,
    prototypeId: string,
    requestedName: string | undefined,
    shouldEmit: boolean | undefined,
  ): Promise<PreviewResult | PreviewFailure> {
    const proto = listPrototypes(cwd).find((entry) => entry.id === prototypeId);
    if (!proto) return { ok: false, error: `No prototype ${prototypeId}.` };
    const id = previewId(cwd, `proto:${proto.id}`);
    const dir = await generatedPreviewDirectory(id);
    await writeFile(join(dir, 'index.html'), proto.html, 'utf8');
    return this.serve({
      cwd,
      id,
      dir,
      entry: 'index.html',
      assets: ['index.html'],
      label: requestedName ?? proto.name,
      source: { type: 'prototype', prototypeId: proto.id },
      shouldEmit: shouldEmit ?? true,
    });
  }

  private async renderWorkspaceHtml(
    cwd: string,
    path: string,
    requestedName: string | undefined,
    shouldEmit: boolean | undefined,
  ): Promise<PreviewResult | PreviewFailure> {
    const abs = resolve(cwd, path);
    if (abs !== cwd && !abs.startsWith(cwd + sep)) {
      return { ok: false, error: 'That path is outside the workspace.' };
    }
    if (!/\.html?$/i.test(abs)) {
      return { ok: false, error: 'The entry page must be an .html file.' };
    }
    const html = await readFile(abs, 'utf8');
    const id = previewId(cwd, `dir:${dirname(abs)}`);
    return this.serve({
      cwd,
      id,
      dir: dirname(abs),
      entry: basename(abs),
      assets: await workspaceHtmlAssets(abs, html),
      label: requestedName ?? basename(abs),
      source: {
        type: 'workspace-html',
        relativePath: relative(cwd, abs).split(sep).join('/'),
      },
      shouldEmit: shouldEmit ?? true,
    });
  }

  async resolveSource(
    cwd: string,
    source: CanvasFrameSource,
  ): Promise<{ url?: string; error?: string }> {
    try {
      if (source.type === 'url') return { url: source.url };
      if (source.type === 'brand-book') {
        const result = await this.renderBrandBook(cwd, false);
        return { url: result.url };
      }
      if (source.type === 'component') {
        const result = await this.renderComponent({ cwd, ...source }, false);
        return { url: result.url };
      }
      const result =
        source.type === 'prototype'
          ? await this.render({ cwd, prototypeId: source.prototypeId, shouldEmit: false })
          : await this.render({ cwd, path: source.relativePath, shouldEmit: false });
      return result.ok ? { url: result.url } : { error: result.error };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async resolveImageAsset(
    cwd: string,
    libraryId: string,
  ): Promise<{ name?: string; url?: string; error?: string }> {
    const item = getLibraryItem(cwd, libraryId, this.baseDir);
    if (!item) return { error: 'The referenced library image no longer exists.' };
    if (!item.screenshotPath) {
      return { name: item.name, error: 'The referenced library item has no durable image file.' };
    }

    try {
      const [imageDirectory, imageFile] = await Promise.all([
        realpath(referenceImageDir(cwd, this.baseDir)),
        realpath(item.screenshotPath),
      ]);
      const imageInfo = await stat(imageFile);
      if (!imageInfo.isFile() || dirname(imageFile) !== imageDirectory) {
        return {
          name: item.name,
          error: 'The referenced library image is outside its asset store.',
        };
      }

      await this.previewServer.start();
      const projectId = resolveDesignProjectIdentity(cwd).id;
      const id = `canvas-image-${createHash('sha1')
        .update(`${projectId}:${libraryId}`)
        .digest('hex')
        .slice(0, 16)}`;
      const base = await this.previewServer.register(id, imageDirectory, [basename(imageFile)]);
      return { name: item.name, url: `${base}${encodeURIComponent(basename(imageFile))}` };
    } catch {
      return { name: item.name, error: 'The durable library image could not be read.' };
    }
  }

  private async serve(input: {
    cwd: string;
    id: string;
    dir: string;
    entry: string;
    assets: readonly string[];
    label: string;
    source: CanvasFrameSource;
    kind?: 'page' | 'component';
    shouldEmit: boolean;
  }): Promise<PreviewResult> {
    await this.previewServer.start();
    const base = await this.previewServer.register(input.id, input.dir, input.assets);
    const url = input.entry === 'index.html' ? base : `${base}${encodeURIComponent(input.entry)}`;
    if (input.shouldEmit) {
      this.emit({
        type: 'design.preview',
        cwd: input.cwd,
        id: input.id,
        name: input.label,
        url,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        source: input.source,
      });
    }
    return { ok: true, url, name: input.label, source: input.source };
  }
}

function previewId(cwd: string, key: string): string {
  return `preview-${createHash('sha1').update(`${cwd} ${key}`).digest('hex').slice(0, 12)}`;
}

const PREVIEW_ASSET_EXTENSIONS = new Set([
  '.avif',
  '.css',
  '.gif',
  '.htm',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.mjs',
  '.mp4',
  '.otf',
  '.png',
  '.svg',
  '.ttf',
  '.wasm',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
]);
const PARSED_PREVIEW_EXTENSIONS = new Set(['.css', '.htm', '.html', '.js', '.mjs']);
const SENSITIVE_ASSET_NAME =
  /(^|[-_.])(credential|credentials|env|key|private|secret|secrets|token|tokens)([-_.]|$)/i;
const MAX_PREVIEW_ASSETS = 512;

async function workspaceHtmlAssets(entryPath: string, html: string): Promise<string[]> {
  const root = dirname(entryPath);
  const entry = basename(entryPath);
  const assets = new Set([entry]);
  const queued = [{ relativePath: entry, content: html }];

  while (queued.length > 0 && assets.size < MAX_PREVIEW_ASSETS) {
    const current = queued.shift();
    if (!current) break;
    for (const reference of previewReferences(current.content)) {
      const resolved = resolve(root, dirname(current.relativePath), reference);
      const relativePath = relative(root, resolved).split(sep).join('/');
      if (!isSafePreviewAsset(relativePath) || assets.has(relativePath)) continue;
      try {
        const content = await readPreviewAsset(
          resolved,
          PARSED_PREVIEW_EXTENSIONS.has(extname(relativePath).toLowerCase()),
        );
        if (content === null) continue;
        assets.add(relativePath);
        if (content !== undefined) queued.push({ relativePath, content });
      } catch {
        // A missing optional asset should not make the whole preview unusable.
      }
      if (assets.size >= MAX_PREVIEW_ASSETS) break;
    }
  }
  return [...assets];
}

async function readPreviewAsset(
  file: string,
  includeContent: boolean,
): Promise<string | null | undefined> {
  const asset = await open(file, 'r');
  try {
    if (!(await asset.stat()).isFile()) return null;
    return includeContent ? await asset.readFile('utf8') : undefined;
  } finally {
    await asset.close();
  }
}

let generatedPreviewRoot: Promise<string> | undefined;

async function generatedPreviewDirectory(id: string): Promise<string> {
  generatedPreviewRoot ??= mkdtemp(join(tmpdir(), 'droidex-preview-'));
  const dir = join(await generatedPreviewRoot, id);
  await mkdir(dir, { recursive: true });
  return dir;
}

function previewReferences(content: string): string[] {
  const references = new Set<string>();
  const addReference = (value: string): void => {
    const reference = value.trim().split(/[?#]/, 1)[0];
    if (
      reference === '' ||
      reference.startsWith('/') ||
      reference.startsWith('//') ||
      /^[a-z][a-z\d+.-]*:/i.test(reference)
    ) {
      return;
    }
    references.add(reference);
  };
  const patterns = [
    /\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi,
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gi,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gi,
    /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi,
    /\bnew\s+(?:Shared)?Worker\s*\(\s*["']([^"']+)["']/gi,
    /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      addReference(match[1]);
    }
  }
  for (const match of content.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const candidate of match[1].split(',')) {
      const [reference] = candidate.trim().split(/\s+/, 1);
      if (reference) addReference(reference);
    }
  }
  return [...references];
}

function isSafePreviewAsset(relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (relativePath === '..' || relativePath.startsWith('../')) {
    return false;
  }
  if (
    segments.some(
      (segment) =>
        segment.startsWith('.') ||
        SENSITIVE_ASSET_NAME.test(segment) ||
        /^(?:package|pnpm-lock|yarn\.lock)/i.test(segment),
    )
  ) {
    return false;
  }
  const name = basename(relativePath);
  return PREVIEW_ASSET_EXTENSIONS.has(extname(name).toLowerCase());
}
