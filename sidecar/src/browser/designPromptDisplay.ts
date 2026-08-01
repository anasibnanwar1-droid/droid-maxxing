import { readFileSync } from 'node:fs';
import type { BrowserTranscriptReference } from '../protocol.js';
import type { DesignPromptPack, DesignReference } from './types.js';
import { isBrowserAssetPath } from './browserPaths.js';

export interface DesignPromptDisplay {
  text: string;
  browserRefs?: BrowserTranscriptReference[];
}

const PACK_PATH_RE = /^- References JSON:\s*(.+)$/m;
const INSTRUCTION_RE = /\nUser instruction:\n([\s\S]*)$/;
const DNA_POINTER_MARKER = '\n\nProject design DNA:\n';
const STUDIO_REFERENCE_MARKER = '\n\nDROIDEX DESIGN reference pack:\n';

export function designPromptDisplayFromText(
  text: string,
  options: { browserDataDir?: string } = {},
): DesignPromptDisplay | null {
  const visibleText = withoutInternalDnaPointer(text);
  const studioReferenceIndex = visibleText.indexOf(STUDIO_REFERENCE_MARKER);
  if (studioReferenceIndex >= 0) {
    const pack = visibleText.slice(studioReferenceIndex + STUDIO_REFERENCE_MARKER.length).trim();
    const browserRefs = readStudioCanvasRefs(pack);
    return {
      text: visibleText.slice(0, studioReferenceIndex).trimEnd(),
      browserRefs: browserRefs.length ? browserRefs : undefined,
    };
  }
  if (!visibleText.startsWith('Design Mode reference pack:')) {
    return visibleText === text ? null : { text: visibleText };
  }
  const instruction = INSTRUCTION_RE.exec(visibleText)?.[1]?.trim() ?? visibleText.trim();
  const packPath = PACK_PATH_RE.exec(visibleText)?.[1]?.trim();
  const browserRefs =
    packPath && isBrowserAssetPath(packPath, options.browserDataDir)
      ? readBrowserRefsFromPack(packPath)
      : [];
  return {
    text: instruction,
    browserRefs: browserRefs.length ? browserRefs : undefined,
  };
}

function withoutInternalDnaPointer(text: string): string {
  const markerIndex = text.lastIndexOf(DNA_POINTER_MARKER);
  if (markerIndex < 0) return text;
  const pointer = text.slice(markerIndex + DNA_POINTER_MARKER.length);
  const isInternalPointer =
    pointer.includes('design_system tool') || pointer.includes('Motion rules live in');
  return isInternalPointer ? text.slice(0, markerIndex).trimEnd() : text;
}

function readStudioCanvasRefs(pack: string): BrowserTranscriptReference[] {
  try {
    const parsed = JSON.parse(pack) as { images?: unknown };
    if (!Array.isArray(parsed.images)) return [];
    return parsed.images.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const image = value as Record<string, unknown>;
      const id = typeof image.libraryId === 'string' ? image.libraryId : undefined;
      if (!id) return [];
      const label =
        (typeof image.name === 'string' && image.name.trim()) ||
        (typeof image.tag === 'string' && image.tag.trim()) ||
        'canvas-image';
      return [
        {
          id,
          label,
          kind: 'region' as const,
          url: `droidex://canvas/${id}`,
        },
      ];
    });
  } catch {
    return [];
  }
}

function readBrowserRefsFromPack(packPath: string): BrowserTranscriptReference[] {
  try {
    const pack = JSON.parse(readFileSync(packPath, 'utf8')) as Partial<DesignPromptPack>;
    if (!Array.isArray(pack.references)) return [];
    return pack.references
      .map(browserTranscriptReferenceFromDesignReference)
      .filter((reference): reference is BrowserTranscriptReference => Boolean(reference));
  } catch {
    return [];
  }
}

function browserTranscriptReferenceFromDesignReference(
  reference: Partial<DesignReference>,
): BrowserTranscriptReference | null {
  const anchor = reference.anchor;
  const id = reference.id ?? anchor?.id;
  if (!id || !anchor) return null;
  const attributes = reference.detail?.attributes;
  const label = normalizeBrowserReferenceLabel(
    anchor.name ??
      attributes?.['data-testid'] ??
      attributes?.id ??
      anchor.text ??
      anchor.role ??
      anchor.tag,
    anchor.kind === 'element' ? (anchor.tag ?? 'element') : anchor.kind,
  );
  return {
    id,
    kind: anchor.kind,
    label,
    url: reference.url,
    selector: reference.detail?.selector,
    imageDataUrl: reference.screenshot?.base64
      ? `data:image/png;base64,${reference.screenshot.base64}`
      : undefined,
  };
}

function normalizeBrowserReferenceLabel(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? fallback).replace(/^@+/, '').replace(/\s+/g, ' ').trim();
  const readable = cleaned || fallback;
  const compact = readable
    .replace(/^@+/, '')
    .replace(/[^a-zA-Z0-9._ -]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 36)
    .replace(/[._-]+$/g, '');
  return compact || fallback.replace(/^@+/, '') || 'reference';
}
