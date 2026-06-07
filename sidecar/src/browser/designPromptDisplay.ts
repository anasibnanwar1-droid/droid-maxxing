import { readFileSync } from 'node:fs';
import type { BrowserTranscriptReference } from '../protocol.js';
import type { DesignPromptPack, DesignReference } from './types.js';

export interface DesignPromptDisplay {
  text: string;
  browserRefs?: BrowserTranscriptReference[];
}

const PACK_PATH_RE = /^- References JSON:\s*(.+)$/m;
const INSTRUCTION_RE = /\nUser instruction:\n([\s\S]*)$/;

export function designPromptDisplayFromText(text: string): DesignPromptDisplay | null {
  if (!text.startsWith('Design Mode reference pack:')) return null;
  const instruction = INSTRUCTION_RE.exec(text)?.[1]?.trim() ?? text.trim();
  const packPath = PACK_PATH_RE.exec(text)?.[1]?.trim();
  const browserRefs = packPath ? readBrowserRefsFromPack(packPath) : [];
  return {
    text: instruction,
    browserRefs: browserRefs.length ? browserRefs : undefined,
  };
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

export function browserTranscriptReferenceFromDesignReference(reference: Partial<DesignReference>): BrowserTranscriptReference | null {
  const id = reference.id ?? reference.element?.ref;
  if (!id) return null;
  const element = reference.element;
  const kind = reference.kind ?? 'element';
  const label = normalizeBrowserReferenceLabel(
    element?.name ??
      element?.attributes?.['data-testid'] ??
      element?.attributes?.id ??
      element?.text ??
      element?.role ??
      element?.tagName,
    kind === 'element' ? element?.tagName ?? 'element' : kind,
  );
  return {
    id,
    kind,
    label,
    url: reference.url ?? reference.note,
    selector: element?.selector,
  };
}

export function normalizeBrowserReferenceLabel(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? fallback)
    .replace(/^@+/, '')
    .replace(/\s+/g, ' ')
    .trim();
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
