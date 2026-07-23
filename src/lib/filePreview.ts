/**
 * Renderer-side preview classification helpers for the Files tab.
 *
 * These are pure functions (no I/O) so they can run in the renderer to drive
 * UI hints (icon, size badge, "open externally" affordance) before the
 * main-process `readPreview` round-trip. The authoritative classification
 * lives in `electron/files.cjs`, which mirrors these tables; keep both in
 * sync and exercise the edge cases via the paired unit tests.
 *
 * Categories covered per spec: text/markdown/json/csv (text), raster (image),
 * pdf, docx, xlsx. Everything else resolves to `external` so the UI falls
 * back to opening the file in the OS default application instead of trying
 * to render an unsupported payload.
 */

export type PreviewCategory = 'text' | 'image' | 'pdf' | 'docx' | 'xlsx' | 'external';

/** Maximum payload size the backend will return for a text-classified file. */
export const TEXT_PREVIEW_CAP_BYTES = 5 * 1024 * 1024; // 5 MiB
/** Maximum payload size the backend will return for binary-classified files. */
export const BINARY_PREVIEW_CAP_BYTES = 25 * 1024 * 1024; // 25 MiB

const TEXT_EXTENSIONS = new Set([
  // plain text
  'txt',
  'text',
  'log',
  'md',
  'markdown',
  'mdx',
  // structured text
  'json',
  'json5',
  'jsonc',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'xml',
  // web markup
  'html',
  'htm',
  'xhtml',
  'css',
  'scss',
  'sass',
  'less',
  'styl',
  // code
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'pyi',
  'rb',
  'php',
  'go',
  'rs',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'java',
  'kt',
  'swift',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'lua',
  'pl',
  'r',
  'scala',
  'clj',
  'cljs',
  'ex',
  'exs',
  'erl',
  'hs',
  'ml',
  'mli',
  'fs',
  'fsi',
  'vim',
  // config
  'toml',
  'ini',
  'cfg',
  'conf',
  'config',
  'properties',
  'env',
  'editorconfig',
  // data/query
  'sql',
  'graphql',
  'gql',
  'diff',
  'patch',
  // dotfiles / well-known filenames handled by name below
]);

const TEXT_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'rakefile',
  'gemfile',
  'procfile',
  'babelrc',
  'eslintrc',
  'prettierrc',
  'gitignore',
  'gitattributes',
  'npmrc',
  'yarnrc',
  'nvmrc',
  'bashrc',
  'zshrc',
  'profile',
]);

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'avif',
  'ico',
  'svg',
]);
const PDF_EXTENSIONS = new Set(['pdf']);
const DOCX_EXTENSIONS = new Set(['docx']);
const XLSX_EXTENSIONS = new Set(['xlsx']);

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const base = lower.split(/[\\/]/).pop() ?? lower;
  // Dotfiles such as ".gitignore" should be classified by their full stem so
  // TEXT_FILENAMES can match them.
  if (TEXT_FILENAMES.has(base)) return base;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    // No extension. For dotfiles, strip the leading dot so TEXT_FILENAMES can
    // match "gitignore" without storing the dot prefix.
    return base.startsWith('.') ? base.slice(1) : base;
  }
  return base.slice(dot + 1);
}

export function classifyByName(name: string): PreviewCategory {
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (DOCX_EXTENSIONS.has(ext)) return 'docx';
  if (XLSX_EXTENSIONS.has(ext)) return 'xlsx';
  return 'external';
}

export function previewSizeCapBytes(category: PreviewCategory): number {
  return category === 'text' ? TEXT_PREVIEW_CAP_BYTES : BINARY_PREVIEW_CAP_BYTES;
}

export function isPreviewable(category: PreviewCategory): boolean {
  return category !== 'external';
}

export interface PreviewClassification {
  category: PreviewCategory;
  previewable: boolean;
  sizeCapBytes: number;
}

export function classifyPreview(name: string): PreviewClassification {
  const category = classifyByName(name);
  return {
    category,
    previewable: isPreviewable(category),
    sizeCapBytes: previewSizeCapBytes(category),
  };
}

/**
 * Returns a short label suitable for a size badge. Centralised so the renderer
 * and any future empty-state copy stay consistent.
 */
export function previewSizeLabel(category: PreviewCategory): string {
  if (category === 'text') return '5 MiB text';
  if (category === 'external') return 'Open externally';
  return '25 MiB binary';
}
