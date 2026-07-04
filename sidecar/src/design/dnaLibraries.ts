import { serializeTokenBlock } from './tokens.js';
import type { DesignTokens, DnaLibrary, DnaLibrarySummary } from './types.js';

interface LibraryDefinition {
  id: string;
  name: string;
  tagline: string;
  tokens: DesignTokens;
  voice: string[];
  rules: string[];
  motion: string[];
}

const DEFINITIONS: LibraryDefinition[] = [
  {
    id: 'swiss-editorial',
    name: 'Swiss Editorial',
    tagline: 'Grid-first layouts, generous whitespace, one accent used sparingly.',
    tokens: {
      colors: {
        paper: '#fafaf8',
        ink: '#111110',
        graphite: '#4a4a46',
        hairline: '#d9d9d4',
        accent: '#d43d2a',
      },
      fonts: {
        sans: '"Neue Haas Grotesk", "Helvetica Neue", Arial, sans-serif',
        display: '"Tiempos Headline", Georgia, serif',
      },
      typeScale: [13, 15, 18, 24, 34, 48, 68],
      spacing: [4, 8, 12, 16, 24, 40, 64, 96],
      radii: [0, 2],
    },
    voice: [
      'Confident and quiet. The layout does the talking.',
      'Headlines are large serif statements; body copy stays small and dense.',
      'The accent red appears once per view, never for decoration.',
    ],
    rules: [
      'No drop shadows, no gradients, no rounded cards.',
      'Rule lines (1px hairline) separate sections instead of boxes.',
      'Align everything to an 8px baseline grid.',
    ],
    motion: [
      'Almost none. Content appears with a 120ms opacity fade, nothing moves.',
      'Hover states change color only; no scale, no translate.',
      'Page transitions are instant cuts, like turning a printed page.',
    ],
  },
  {
    id: 'terminal-mono',
    name: 'Terminal Mono',
    tagline: 'Dark, dense, monospaced. Built for operators, not onlookers.',
    tokens: {
      colors: {
        bg: '#0a0c0a',
        surface: '#111511',
        text: '#c8e6c9',
        dim: '#5f7a5f',
        amber: '#e6b450',
        alert: '#e2574c',
      },
      fonts: {
        mono: '"Berkeley Mono", "JetBrains Mono", "SF Mono", monospace',
      },
      typeScale: [11, 12, 13, 15, 18, 24],
      spacing: [2, 4, 8, 12, 16, 24, 32],
      radii: [0, 3],
    },
    voice: [
      'Terse. Labels read like command output: lowercase, abbreviated.',
      'Every pixel earns its place; density is a feature.',
      'Amber marks state changes, red is reserved for failure.',
    ],
    rules: [
      'Monospace everywhere, including headings.',
      'Borders are 1px solid dim green; no shadows.',
      'Tables and aligned columns over cards and tiles.',
    ],
    motion: [
      'Blinking caret and sub-100ms fades only.',
      'New rows appear instantly; no slide-ins.',
      'A subtle scanline shimmer is acceptable on empty states, nowhere else.',
    ],
  },
  {
    id: 'soft-depth',
    name: 'Soft Depth',
    tagline: 'Layered light surfaces, big radii, calm shadows. Friendly SaaS.',
    tokens: {
      colors: {
        canvas: '#f5f6f8',
        card: '#ffffff',
        text: '#1c2430',
        muted: '#66707f',
        primary: '#3b6ef6',
        mint: '#2fbf8f',
      },
      fonts: {
        sans: 'Inter, "SF Pro Text", system-ui, sans-serif',
      },
      typeScale: [12, 14, 16, 20, 26, 34],
      spacing: [4, 8, 12, 16, 20, 28, 40, 56],
      radii: [8, 12, 16, 24],
      shadows: ['0 1px 2px rgba(16,24,40,0.06)', '0 8px 24px rgba(16,24,40,0.10)'],
    },
    voice: [
      'Warm and helpful. Sentences over labels where space allows.',
      'Blue is action, mint is success; neutrals carry everything else.',
      'Empty states teach instead of apologize.',
    ],
    rules: [
      'Cards float on the canvas with the small shadow; the large shadow is for overlays only.',
      'Minimum radius is 8px; buttons and inputs share the same radius.',
      'Never place pure white on pure white; use the canvas gray to separate.',
    ],
    motion: [
      'Spring-based: entrances translate 8px up with a 250ms ease-out.',
      'Hover lifts cards 1px with the larger shadow at 40% opacity.',
      'Overlays fade + scale from 0.98; nothing bounces.',
    ],
  },
  {
    id: 'warm-print',
    name: 'Warm Print',
    tagline: 'Cream paper, warm ink, tactile borders. A magazine you can click.',
    tokens: {
      colors: {
        cream: '#f7f1e5',
        ink: '#2b2118',
        rust: '#b4552d',
        olive: '#6d6a3f',
        border: '#d8cdb8',
      },
      fonts: {
        sans: '"Untitled Sans", "Söhne", system-ui, sans-serif',
        display: '"GT Sectra", "Freight Display", Georgia, serif',
      },
      typeScale: [14, 16, 19, 24, 32, 44],
      spacing: [6, 10, 16, 24, 36, 56, 80],
      radii: [0, 4, 6],
    },
    voice: [
      'Literary and unhurried. Long-form copy is welcome.',
      'Rust and olive alternate as accents; never both in one component.',
      'Numbers and metadata sit in small caps.',
    ],
    rules: [
      'Solid 1.5px borders in the border tone instead of shadows.',
      'Backgrounds stay cream; white is reserved for imagery.',
      'Illustrated or typographic empty states; no stock icon parades.',
    ],
    motion: [
      'Slow and deliberate: 300ms ease-in-out fades.',
      'Underlines draw in from the left on link hover.',
      'No parallax, no auto-playing movement.',
    ],
  },
];

export function listDnaLibraries(): DnaLibrarySummary[] {
  return DEFINITIONS.map(summarize);
}

export function getDnaLibrary(id: string): DnaLibrary | undefined {
  const definition = DEFINITIONS.find((item) => item.id === id);
  if (!definition) return undefined;
  return {
    ...summarize(definition),
    design: renderDesign(definition),
    motion: renderMotion(definition),
  };
}

function summarize(definition: LibraryDefinition): DnaLibrarySummary {
  return {
    id: definition.id,
    name: definition.name,
    tagline: definition.tagline,
    colors: Object.values(definition.tokens.colors).slice(0, 6),
    fonts: Object.values(definition.tokens.fonts).filter(
      (font): font is string => typeof font === 'string',
    ),
  };
}

function renderDesign(definition: LibraryDefinition): string {
  const paletteLines = Object.entries(definition.tokens.colors)
    .map(([name, value]) => `- \`${name}\`: ${value}`)
    .join('\n');
  return [
    `# ${definition.name}`,
    '',
    definition.tagline,
    '',
    '## Palette',
    '',
    paletteLines,
    '',
    '## Voice',
    '',
    definition.voice.map((line) => `- ${line}`).join('\n'),
    '',
    '## Rules',
    '',
    definition.rules.map((line) => `- ${line}`).join('\n'),
    '',
    '## Tokens',
    '',
    serializeTokenBlock(definition.tokens),
    '',
  ].join('\n');
}

function renderMotion(definition: LibraryDefinition): string {
  return [
    `# ${definition.name}: motion`,
    '',
    definition.motion.map((line) => `- ${line}`).join('\n'),
    '',
  ].join('\n');
}
