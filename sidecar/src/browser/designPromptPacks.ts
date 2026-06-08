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
    `- URL: ${first?.url ?? 'about:blank'}`,
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

function formatReferenceLine(reference: DesignReference): string {
  const anchor = reference.anchor;
  const parts = [`- ${reference.id} (${anchor.kind}) ${anchor.label}`];
  if (reference.detail?.selector) {
    parts.push(`selector=${reference.detail.selector}${reference.detail.selectorVerified ? ' [verified]' : ''}`);
  }
  const source = anchor.source;
  if (source?.component) {
    parts.push(`component=${source.component}${source.file ? ` (${source.file}${source.line ? `:${source.line}` : ''})` : ''}`);
  }
  if (anchor.screenshotPath) parts.push(`crop=${anchor.screenshotPath}`);
  return parts.join(' | ');
}
