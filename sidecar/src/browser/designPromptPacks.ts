import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserDesignReferenceDir } from './browserPaths.js';
import type { DesignPromptPack, DesignReference } from './types.js';

export interface WriteDesignPromptPackOptions {
  appSessionId: string;
  browserSessionId: string;
  instruction: string;
  references: DesignReference[];
  baseDir?: string;
  now?: () => Date;
}

export async function writeDesignPromptPack(
  options: WriteDesignPromptPackOptions,
): Promise<{ pack: DesignPromptPack; path: string }> {
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const pack: DesignPromptPack = {
    appSessionId: options.appSessionId,
    browserSessionId: options.browserSessionId,
    createdAt,
    instruction: options.instruction,
    references: options.references,
  };
  const dir = browserDesignReferenceDir(options.appSessionId, options.baseDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `pack-${createdAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(path, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  return { pack, path };
}

// First line of every design prompt. Used both as the human-facing header and
// as a content marker so other layers (transcript display, tool-policy scoping)
// can recognize a design turn from the prompt text alone.
const DESIGN_PROMPT_HEADER = 'Design Mode reference pack:';

export function isDesignPrompt(text: string): boolean {
  return text.startsWith(DESIGN_PROMPT_HEADER);
}

export interface DesignPromptContext {
  // Extra lines injected after the guidance block, e.g. project DNA file
  // pointers produced by the design manager. Must already be sanitized.
  dnaLines?: string[];
}

// The visible prompt is deliberately compact — a marker, the pack path, and
// pointers. The heavy context (per-reference detail, the operating guidelines,
// the DNA tokens) is READ by the agent through MCP tools (design_reference,
// design_guidelines, design_dna / design_system), never force-injected here, so
// the CLI shows the user's real instruction, not a wall of text.
export function formatDesignPrompt(
  packPath: string,
  instruction: string,
  references: DesignReference[],
  context?: DesignPromptContext,
): string {
  const first = references[0];
  const dnaBlock = context?.dnaLines && context.dnaLines.length > 0 ? context.dnaLines : [];
  return [
    DESIGN_PROMPT_HEADER,
    `- URL: ${sanitizeInline(first?.url ?? 'about:blank')}`,
    `- References JSON: ${packPath}`,
    `- ${references.length} selection(s). Use the design_reference tool (ids are in the pack) for full attributes, computed styles, ancestors, outerHTML, and source file:line.`,
    "- Act as this project's designer: read the design_guidelines tool (how to work + what to avoid) and design_dna / design_system (tokens) before changing anything, then follow them.",
    ...dnaBlock,
    '',
    'User instruction:',
    instruction,
  ].join('\n');
}

// Page-derived strings (labels, selectors, component names, paths) are
// attacker-influenced via page content. Collapse control characters and
// newlines so they cannot break out of their line and inject prompt structure.
export function sanitizeInline(value: string, max = 500): string {
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
