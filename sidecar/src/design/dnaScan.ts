import fs from 'node:fs';
import path from 'node:path';
import { serializeTokenBlock } from './tokens.js';
import { serializeMotionTokenBlock } from './motionTokens.js';
import type { DesignTokens, DnaDraft } from './types.js';

// Bounded repo scan that drafts a DESIGN.md from what the project already
// ships: Tailwind config colors, CSS custom properties, and font stacks.

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.next',
  'vendor',
]);
const MAX_FILES = 60;
const MAX_FILE_BYTES = 512 * 1024;

const HEX_COLOR = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
const NAMED_HEX = /['"]?([a-zA-Z][\w-]{1,32})['"]?\s*:\s*['"](#[0-9a-fA-F]{3,8})['"]/g;
const CUSTOM_PROP = /--([\w-]+)\s*:\s*([^;]+);/g;
const FONT_FAMILY = /font-family\s*:\s*([^;]+);/g;
const PX_VALUE = /\b(\d+(?:\.\d+)?)px\b/g;

export function scanRepoForDna(cwd: string): DnaDraft {
  const sources: string[] = [];
  const colors = new Map<string, string>();
  const fonts = new Set<string>();
  const fontSizes = new Set<number>();
  const radii = new Set<number>();
  const spacing = new Set<number>();

  for (const file of collectFiles(cwd)) {
    let text: string;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(file, 'r');
      const stat = fs.fstatSync(descriptor);
      if (stat.size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(descriptor, 'utf8');
    } catch {
      continue;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    const relative = path.relative(cwd, file);
    let matched = false;

    if (isTailwindConfig(file)) {
      for (const match of text.matchAll(NAMED_HEX)) {
        colors.set(match[1], match[2].toLowerCase());
        matched = true;
      }
    }
    if (file.endsWith('.css')) {
      for (const match of text.matchAll(CUSTOM_PROP)) {
        const value = match[2].trim();
        if (HEX_COLOR.test(value) || value.startsWith('rgb')) {
          colors.set(match[1], value);
          matched = true;
        }
        HEX_COLOR.lastIndex = 0;
      }
      for (const match of text.matchAll(FONT_FAMILY)) {
        fonts.add(match[1].trim());
        matched = true;
      }
      for (const match of text.matchAll(PX_VALUE)) {
        const px = Number(match[1]);
        if (px >= 10 && px <= 96) fontSizes.add(px);
        if (px >= 0 && px <= 48) {
          radii.add(px);
          spacing.add(px);
        }
      }
    }
    if (matched && sources.length < 12) sources.push(relative);
  }

  const tokens: DesignTokens = {
    colors: Object.fromEntries([...colors].slice(0, 24)),
    fonts: pickFonts(fonts),
    typeScale: sorted(fontSizes).slice(0, 10),
    spacing: sorted(spacing).slice(0, 12),
    radii: sorted(radii).slice(0, 8),
  };
  return {
    cwd,
    content: draftMarkdown(cwd, tokens, sources),
    motion: defaultMotionMarkdown(),
    tokens,
    sources,
  };
}

// A sensible, opinionated MOTION.md so a scanned project gets a working motion
// contract out of the box. Curated systems override this with their own.
function defaultMotionMarkdown(): string {
  return [
    '# Motion',
    '',
    'How this product moves. Motion should feel quick and intentional, never',
    'decorative. When in doubt, do less.',
    '',
    '## Easing',
    '',
    '- Standard: `cubic-bezier(0.16, 1, 0.3, 1)` — the default for entrances and moves.',
    '- Exit: `cubic-bezier(0.4, 0, 1, 1)` — accelerate out.',
    '',
    '## Duration',
    '',
    '- Micro (hover, press, toggles): 120–160ms.',
    '- Elements (cards, menus, popovers): 200–260ms.',
    '- Page / large surfaces: 300–420ms.',
    '',
    '## Interaction',
    '',
    '- Hover: subtle — a small color or elevation shift, no scale jumps.',
    '- Press: a light `scale(0.97)` with a fast return.',
    '- Enter: fade + 6–8px rise on the standard easing, stagger lists by ~40ms.',
    '',
    '## Reduced motion',
    '',
    '- Honor `prefers-reduced-motion`: drop transforms, keep opacity-only fades,',
    '  and never auto-play looping motion.',
    '',
    '## Motion tokens',
    '',
    serializeMotionTokenBlock({
      durations: { micro: [120, 160], element: [200, 260], page: [300, 420] },
      easings: {
        standard: 'cubic-bezier(0.16, 1, 0.3, 1)',
        exit: 'cubic-bezier(0.4, 0, 1, 1)',
      },
      pressScale: 0.97,
      reducedMotion: 'reduce',
    }),
    '',
  ].join('\n');
}

function collectFiles(cwd: string): string[] {
  const out: string[] = [];
  const queue = [cwd];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const dir = queue.shift();
    if (!dir) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push(path.join(dir, entry.name));
        }
        continue;
      }
      if (entry.isFile() && (entry.name.endsWith('.css') || isTailwindConfig(entry.name))) {
        out.push(path.join(dir, entry.name));
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

function isTailwindConfig(file: string): boolean {
  return /tailwind\.config\.(js|cjs|mjs|ts)$/.test(path.basename(file));
}

function pickFonts(fonts: Set<string>): DesignTokens['fonts'] {
  const out: DesignTokens['fonts'] = {};
  for (const stack of fonts) {
    const lower = stack.toLowerCase();
    if (!out.mono && (lower.includes('mono') || lower.includes('courier'))) out.mono = stack;
    else out.sans ??= stack;
  }
  return out;
}

function sorted(values: Set<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

function draftMarkdown(cwd: string, tokens: DesignTokens, sources: string[]): string {
  const projectName = path.basename(cwd);
  const paletteLines = Object.entries(tokens.colors)
    .map(([name, value]) => `- \`${name}\`: ${value}`)
    .join('\n');
  const fontLines = [
    tokens.fonts.sans ? `- Sans: ${tokens.fonts.sans}` : undefined,
    tokens.fonts.mono ? `- Mono: ${tokens.fonts.mono}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
  const sourceLines = sources.map((source) => `- ${source}`).join('\n');
  return [
    `# ${projectName} design DNA`,
    '',
    'Drafted from a repo scan. Edit freely: this file is the contract every',
    'agent reads before touching the UI.',
    '',
    '## Palette',
    '',
    paletteLines || '- No colors found. Add your palette here.',
    '',
    '## Typography',
    '',
    fontLines || '- No font stacks found. Name your typefaces here.',
    '',
    '## Voice',
    '',
    '- Describe the tone of the interface: confident, quiet, playful, dense.',
    '- Note what the design must never do (gradients, drop shadows, emoji).',
    '',
    '## Scanned sources',
    '',
    sourceLines || '- (none)',
    '',
    '## Tokens',
    '',
    serializeTokenBlock(tokens),
    '',
  ].join('\n');
}
