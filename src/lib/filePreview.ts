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

import type { HElement } from 'docx-preview';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

export type PreviewCategory = 'text' | 'image' | 'pdf' | 'docx' | 'xlsx' | 'external';

export const DOCX_PREVIEW_OPTIONS = {
  inWrapper: true,
  ignoreWidth: false,
  ignoreHeight: false,
  breakPages: true,
  experimental: false,
  // docx-preview renders alt chunks as unsandboxed srcdoc iframes.
  renderAltChunks: false,
  className: 'docx-preview',
} as const;

const DOCX_ACTIVE_CONTENT_SELECTOR = 'script, iframe, object, embed, link, meta, base, form';
const DOCX_URL_ATTRIBUTES = new Set([
  'href',
  'xlink:href',
  'src',
  'action',
  'formaction',
  'poster',
]);
const DOCX_MARKUP_ATTRIBUTES = new Set(['innerhtml', 'outerhtml', 'srcdoc']);

function isSafeDocxUrl(value: string): boolean {
  let normalized = '';
  for (const character of value.trim()) {
    const codePoint = character.charCodeAt(0);
    if (codePoint > 0x20 && codePoint !== 0x7f) normalized += character;
  }
  return normalized === '' || normalized.startsWith('#') || /^blob:/i.test(normalized);
}

function normalizeCssForSecurity(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\(?:\r\n|[\n\r\f])/g, '')
    .replace(
      /\\([0-9a-f]{1,6})(?:[ \n\r\t\f])?|\\([^0-9a-f\n\r\f])/gi,
      (_match, hex: string | undefined, escaped: string | undefined) => {
        if (!hex) return escaped ?? '';
        const codePoint = Number.parseInt(hex, 16);
        return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd';
      },
    )
    .toLowerCase();
}

export function sanitizeDocxCssText(css: string): string {
  const normalized = normalizeCssForSecurity(css);
  if (/@import(?:\s|["'(;]|$)/i.test(normalized)) return '';

  let unsafeUrl = false;
  const withoutBlobUrls = normalized.replace(
    /url\s*\(\s*(['"]?)([^)]*?)\1\s*\)/gi,
    (match, _quote: string, value: string) => {
      if (/^blob:[^'"\s()]+$/i.test(value.trim())) return '';
      unsafeUrl = true;
      return match;
    },
  );
  if (unsafeUrl || /url\s*\(/i.test(withoutBlobUrls)) return '';
  if (
    /(?:https?|ftp|file|data|javascript|vbscript)\s*:/i.test(withoutBlobUrls) ||
    /(^|[^:])\/\//.test(withoutBlobUrls)
  ) {
    return '';
  }
  return css;
}

function sanitizeDocxStyle(style: HElement['style']): HElement['style'] | undefined {
  if (typeof style === 'string') return sanitizeDocxCssText(style) || undefined;
  if (!style) return undefined;

  const sanitized = Object.fromEntries(
    Object.entries(style).filter(
      ([property, value]) => sanitizeDocxCssText(`${property}:${value}`) !== '',
    ),
  );
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function createSanitizedDocxElementFactory(document: Document) {
  const blockedTags = new Set(
    DOCX_ACTIVE_CONTENT_SELECTOR.split(',').map((selector) => selector.trim()),
  );

  const create = (input: HElement | Node | string): Node => {
    if (typeof input === 'string') return document.createTextNode(input);
    if (typeof (input as Node).nodeType === 'number') return input as Node;

    const { ns, tagName, className, style, children, ...props } = input as HElement;
    const normalizedTag = tagName.toLowerCase();
    if (normalizedTag === '#fragment') return document.createDocumentFragment();
    if (normalizedTag === '#comment') {
      return document.createComment(String(children?.[0] ?? ''));
    }
    if (blockedTags.has(normalizedTag)) return document.createDocumentFragment();

    const element = ns ? document.createElementNS(ns, tagName) : document.createElement(tagName);
    if (className) element.setAttribute('class', className);

    const safeStyle = sanitizeDocxStyle(style);
    if (typeof safeStyle === 'string') {
      element.setAttribute('style', safeStyle);
    } else if (safeStyle) {
      Object.assign((element as HTMLElement).style, safeStyle);
    }

    for (const [name, value] of Object.entries(props)) {
      const normalizedName = name.toLowerCase();
      if (
        value === undefined ||
        normalizedName.startsWith('on') ||
        DOCX_MARKUP_ATTRIBUTES.has(normalizedName) ||
        (DOCX_URL_ATTRIBUTES.has(normalizedName) && !isSafeDocxUrl(String(value)))
      ) {
        continue;
      }
      (element as unknown as Record<string, unknown>)[name] = value;
    }

    for (const child of children ?? []) element.appendChild(create(child));
    return element;
  };

  return create;
}

export function sanitizeDocxPreview(container: ParentNode): void {
  container.querySelectorAll('style').forEach((element) => {
    const css = sanitizeDocxCssText(element.textContent ?? '');
    if (!css) element.remove();
    else element.textContent = css;
  });

  container.querySelectorAll(DOCX_ACTIVE_CONTENT_SELECTOR).forEach((element) => {
    element.remove();
  });

  container.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith('on') ||
        DOCX_MARKUP_ATTRIBUTES.has(name) ||
        (name === 'style' && !sanitizeDocxCssText(attribute.value)) ||
        (DOCX_URL_ATTRIBUTES.has(name) && !isSafeDocxUrl(attribute.value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
}

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

export async function loadPdfDocumentForPreview(
  loadLibrary: () => Promise<{
    getDocument: (input: { data: Uint8Array; isEvalSupported: boolean }) => PDFDocumentLoadingTask;
  }>,
  bytes: Uint8Array,
  isCancelled: () => boolean,
  onLoadingTask: (task: PDFDocumentLoadingTask) => void,
): Promise<PDFDocumentProxy | null> {
  const pdfjsLib = await loadLibrary();
  if (isCancelled()) return null;
  const loadingTask = pdfjsLib.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
  });
  onLoadingTask(loadingTask);
  const doc = await loadingTask.promise;
  if (isCancelled()) {
    await loadingTask.destroy();
    return null;
  }
  return doc;
}

function readQuotedCharacter(
  text: string,
  index: number,
): { value: string; nextIndex: number; closed: boolean } {
  const ch = text[index];
  if (ch !== '"') return { value: ch, nextIndex: index, closed: false };
  if (text[index + 1] === '"') return { value: '"', nextIndex: index + 1, closed: false };
  return { value: '', nextIndex: index, closed: true };
}

export function parseDelimitedText(
  text: string,
  delimiter: string,
  rowLimit: number,
  columnLimit: number,
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let columnLimitReached = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      const quoted = readQuotedCharacter(text, i);
      i = quoted.nextIndex;
      if (quoted.closed) {
        inQuotes = false;
      } else if (!columnLimitReached) {
        field += quoted.value;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      if (row.length < columnLimit - 1) {
        row.push(field);
        field = '';
      } else {
        columnLimitReached = true;
      }
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      columnLimitReached = false;
      if (rows.length >= rowLimit) break;
    } else if (!columnLimitReached) {
      field += ch;
    }
  }

  if (rows.length < rowLimit && (field || row.length)) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
