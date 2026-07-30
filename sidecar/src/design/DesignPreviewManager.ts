import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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
    const dir = join(tmpdir(), 'droidex-preview', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), html, 'utf8');
    return this.serve({
      cwd,
      id,
      dir,
      entry: 'index.html',
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
    const requestedName = input.name?.trim();
    let label = requestedName !== undefined && requestedName !== '' ? requestedName : 'Preview';
    try {
      if (input.prototypeId) {
        const proto = listPrototypes(cwd).find((entry) => entry.id === input.prototypeId);
        if (!proto) return { ok: false, error: `No prototype ${input.prototypeId}.` };
        if (!input.name?.trim()) label = proto.name;
        const id = previewId(cwd, `proto:${proto.id}`);
        const dir = join(tmpdir(), 'droidex-preview', id);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'index.html'), proto.html, 'utf8');
        return await this.serve({
          cwd,
          id,
          dir,
          entry: 'index.html',
          label,
          source: { type: 'prototype', prototypeId: proto.id },
          shouldEmit: input.shouldEmit ?? true,
        });
      }
      if (input.path?.trim()) {
        const abs = resolve(cwd, input.path.trim());
        if (abs !== cwd && !abs.startsWith(cwd + sep)) {
          return { ok: false, error: 'That path is outside the workspace.' };
        }
        if (!/\.html?$/i.test(abs)) {
          return { ok: false, error: 'The entry page must be an .html file.' };
        }
        await readFile(abs, 'utf8');
        if (!input.name?.trim()) label = basename(abs);
        const id = previewId(cwd, `dir:${dirname(abs)}`);
        return await this.serve({
          cwd,
          id,
          dir: dirname(abs),
          entry: basename(abs),
          label,
          source: {
            type: 'workspace-html',
            relativePath: relative(cwd, abs).split(sep).join('/'),
          },
          shouldEmit: input.shouldEmit ?? true,
        });
      }
      return { ok: false, error: 'Pass a path or a prototypeId to preview.' };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not read the file.',
      };
    }
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
      const base = this.previewServer.register(id, imageDirectory);
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
    label: string;
    source: CanvasFrameSource;
    kind?: 'page' | 'component';
    shouldEmit: boolean;
  }): Promise<PreviewResult> {
    await this.previewServer.start();
    const base = this.previewServer.register(input.id, input.dir);
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
