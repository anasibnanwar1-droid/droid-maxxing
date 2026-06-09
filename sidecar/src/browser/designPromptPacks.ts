import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserDesignReferenceDir } from './browserPaths.js';
import type { DesignPromptPack, DesignReference } from './types.js';

export interface WriteDesignPromptPackOptions {
  missionId: string;
  browserSessionId: string;
  instruction: string;
  references: DesignReference[];
  baseDir?: string;
  now?: () => Date;
}

export async function writeDesignPromptPack(options: WriteDesignPromptPackOptions): Promise<{ pack: DesignPromptPack; path: string }> {
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const pack: DesignPromptPack = {
    missionId: options.missionId,
    browserSessionId: options.browserSessionId,
    createdAt,
    instruction: options.instruction,
    references: options.references,
  };
  const dir = browserDesignReferenceDir(options.missionId, options.baseDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `pack-${createdAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(path, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  return { pack, path };
}

export function formatDesignPrompt(packPath: string, instruction: string, references: DesignReference[]): string {
  const first = references[0];
  return [
    'Design Mode reference pack:',
    `- URL: ${sanitizeInline(first?.url ?? 'about:blank')}`,
    `- References JSON: ${packPath}`,
    '',
    'Anchored references:',
    ...references.map(formatReferenceLine),
    '',
    'Call the design_reference tool with an @id for full attributes, computed styles, ancestors, and outerHTML.',
    '',
    'User instruction:',
    instruction,
  ].join('\n');
}

// Page-derived strings (labels, selectors, component names, paths) are
// attacker-influenced via page content. Collapse control characters and
// newlines so they cannot break out of their line and inject prompt structure.
function sanitizeInline(value: string, max = 500): string {
  const cleaned = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function formatReferenceLine(reference: DesignReference): string {
  const anchor = reference.anchor;
  const parts = [`- ${sanitizeInline(reference.id)} (${sanitizeInline(anchor.kind)}) ${sanitizeInline(anchor.label)}`];
  if (reference.detail?.selector) {
    parts.push(`selector=${sanitizeInline(reference.detail.selector)}${reference.detail.selectorVerified ? ' [verified]' : ''}`);
  }
  const source = anchor.source;
  if (source?.component) {
    const file = source.file ? sanitizeInline(source.file) : '';
    parts.push(`component=${sanitizeInline(source.component)}${file ? ` (${file}${source.line ? `:${source.line}` : ''})` : ''}`);
  }
  if (anchor.screenshotPath) parts.push(`crop=${sanitizeInline(anchor.screenshotPath)}`);
  return parts.join(' | ');
}
