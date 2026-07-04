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
export const DESIGN_PROMPT_HEADER = 'Design Mode reference pack:';

export function isDesignPrompt(text: string): boolean {
  return text.startsWith(DESIGN_PROMPT_HEADER);
}

export interface DesignPromptContext {
  // Extra lines injected after the guidance block, e.g. project DNA file
  // pointers produced by the design manager. Must already be sanitized.
  dnaLines?: string[];
}

export function formatDesignPrompt(
  packPath: string,
  instruction: string,
  references: DesignReference[],
  context?: DesignPromptContext,
): string {
  const first = references[0];
  const dnaBlock =
    context?.dnaLines && context.dnaLines.length > 0 ? [...context.dnaLines, ''] : [];
  return [
    DESIGN_PROMPT_HEADER,
    `- URL: ${sanitizeInline(first?.url ?? 'about:blank')}`,
    `- References JSON: ${packPath}`,
    '',
    'Anchored references:',
    ...references.map(formatReferenceLine),
    '',
    'Call the design_reference tool with an @id for full attributes, computed styles, ancestors, and outerHTML.',
    '',
    DESIGN_MODE_GUIDANCE,
    '',
    ...dnaBlock,
    'User instruction:',
    instruction,
  ].join('\n');
}

// Kept as the last block before the user instruction so it stays close to the
// request without breaking the `Design Mode reference pack:` / `User
// instruction:` markers the transcript display parser relies on.
const DESIGN_MODE_GUIDANCE = [
  'How to work in Design Mode:',
  '- Scope: change only the design/UI of the referenced elements and the code that renders them. Do not modify backend, data models, APIs, or business logic, and do not spawn subagents to do so. If the requested result truly needs a backend or data change, stop and tell the user exactly what is needed and why, then wait for their go-ahead. Stay on design until the user says otherwise.',
  '- Design system: follow the project Design DNA. Use token names, never raw values that duplicate a token, and never invent tokens or component names. When you need an exact token value, look it up on demand with the design_dna / design_system MCP tool instead of guessing. Respect MOTION.md for every transition, hover, and press, and honor the reduced-motion policy.',
  '- Craft: pick one clear visual idea before writing code. Avoid AI slop: purple gradients, Inter/Roboto/Arial defaults, generic cards, sparkles, emoji icons, glassmorphism/glow. Use real content and ASCII punctuation, no em dashes. Vary the style to fit this product rather than reusing one default look.',
  '- Code quality: ship production-grade, integration-safe code. Keep files small and single-responsibility (no god files; aim under ~500 lines), name things clearly, and reuse existing components and patterns (check design_component_registry) before writing new ones.',
].join('\n');

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

function formatReferenceLine(reference: DesignReference): string {
  const anchor = reference.anchor;
  const parts = [
    `- ${sanitizeInline(reference.id)} (${sanitizeInline(anchor.kind)}) ${sanitizeInline(anchor.label)}`,
  ];
  if (reference.detail?.selector) {
    parts.push(
      `selector=${sanitizeInline(reference.detail.selector)}${reference.detail.selectorVerified ? ' [verified]' : ''}`,
    );
  }
  const source = anchor.source;
  if (source?.component) {
    const file = source.file ? sanitizeInline(source.file) : '';
    parts.push(
      `component=${sanitizeInline(source.component)}${file ? ` (${file}${source.line ? `:${source.line}` : ''})` : ''}`,
    );
  }
  if (anchor.screenshotPath) parts.push(`crop=${sanitizeInline(anchor.screenshotPath)}`);
  return parts.join(' | ');
}
