import type { Language } from 'prism-react-renderer';

export type FilePresentationKind =
  | 'react'
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'css'
  | 'html'
  | 'markdown'
  | 'python'
  | 'rust'
  | 'shell'
  | 'docker'
  | 'package'
  | 'config'
  | 'env'
  | 'image'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'archive'
  | 'unknown';

export interface FilePresentation {
  kind: FilePresentationKind;
  language?: Language;
}

const PACKAGE_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lock',
  'bun.lockb',
  'deno.json',
  'deno.jsonc',
  'composer.json',
  'composer.lock',
  'gemfile',
  'gemfile.lock',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'poetry.lock',
  'requirements.txt',
]);

const MARKDOWN_FILES = new Set([
  'readme',
  'changelog',
  'contributing',
  'code_of_conduct',
  'security',
]);

const DOCUMENT_FILES = new Set(['license', 'licence', 'authors', 'notice']);

const CONFIG_FILES = new Set([
  '.babelrc',
  '.browserslistrc',
  '.editorconfig',
  '.eslintignore',
  '.eslintrc',
  '.gitattributes',
  '.gitignore',
  '.gitmodules',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc',
  '.stylelintrc',
  '.tool-versions',
  'makefile',
  'procfile',
]);

const EXTENSIONS: Readonly<Record<string, FilePresentation>> = {
  tsx: { kind: 'react', language: 'tsx' },
  jsx: { kind: 'react', language: 'jsx' },
  ts: { kind: 'typescript', language: 'typescript' },
  mts: { kind: 'typescript', language: 'typescript' },
  cts: { kind: 'typescript', language: 'typescript' },
  js: { kind: 'javascript', language: 'javascript' },
  mjs: { kind: 'javascript', language: 'javascript' },
  cjs: { kind: 'javascript', language: 'javascript' },
  json: { kind: 'json', language: 'json' },
  jsonc: { kind: 'json', language: 'json' },
  css: { kind: 'css', language: 'css' },
  scss: { kind: 'css', language: 'scss' },
  sass: { kind: 'css', language: 'sass' },
  less: { kind: 'css', language: 'less' },
  html: { kind: 'html', language: 'markup' },
  htm: { kind: 'html', language: 'markup' },
  vue: { kind: 'html', language: 'markup' },
  md: { kind: 'markdown', language: 'markdown' },
  mdx: { kind: 'markdown', language: 'markdown' },
  markdown: { kind: 'markdown', language: 'markdown' },
  py: { kind: 'python', language: 'python' },
  pyw: { kind: 'python', language: 'python' },
  rs: { kind: 'rust', language: 'rust' },
  sh: { kind: 'shell', language: 'bash' },
  bash: { kind: 'shell', language: 'bash' },
  zsh: { kind: 'shell', language: 'bash' },
  fish: { kind: 'shell', language: 'bash' },
  yml: { kind: 'config', language: 'yaml' },
  yaml: { kind: 'config', language: 'yaml' },
  toml: { kind: 'config', language: 'toml' },
  ini: { kind: 'config', language: 'ini' },
  conf: { kind: 'config', language: 'ini' },
  config: { kind: 'config' },
  xml: { kind: 'config', language: 'markup' },
  svg: { kind: 'image', language: 'markup' },
  png: { kind: 'image' },
  jpg: { kind: 'image' },
  jpeg: { kind: 'image' },
  gif: { kind: 'image' },
  webp: { kind: 'image' },
  avif: { kind: 'image' },
  ico: { kind: 'image' },
  bmp: { kind: 'image' },
  tif: { kind: 'image' },
  tiff: { kind: 'image' },
  heic: { kind: 'image' },
  pdf: { kind: 'pdf' },
  doc: { kind: 'document' },
  docx: { kind: 'document' },
  odt: { kind: 'document' },
  rtf: { kind: 'document' },
  txt: { kind: 'document' },
  xls: { kind: 'spreadsheet' },
  xlsx: { kind: 'spreadsheet' },
  ods: { kind: 'spreadsheet' },
  csv: { kind: 'spreadsheet', language: 'csv' },
  tsv: { kind: 'spreadsheet', language: 'csv' },
  zip: { kind: 'archive' },
  tar: { kind: 'archive' },
  gz: { kind: 'archive' },
  tgz: { kind: 'archive' },
  bz2: { kind: 'archive' },
  xz: { kind: 'archive' },
  '7z': { kind: 'archive' },
  rar: { kind: 'archive' },
};

function languageForExtension(extension: string): Language | undefined {
  return EXTENSIONS[extension]?.language;
}

function withLanguage(
  kind: FilePresentationKind,
  language: Language | undefined,
): FilePresentation {
  return language ? { kind, language } : { kind };
}

export function resolveFilePresentation(filename: string): FilePresentation {
  const basename = filename.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  const extension = basename.includes('.') ? basename.slice(basename.lastIndexOf('.') + 1) : '';

  if (/^\.env(?:\.|$)/.test(basename)) return { kind: 'env', language: 'bash' };

  if (
    basename === 'dockerfile' ||
    basename.startsWith('dockerfile.') ||
    basename === '.dockerignore' ||
    /^docker-compose(?:\.[^.]+)?\.ya?ml$/.test(basename) ||
    /^compose(?:\.[^.]+)?\.ya?ml$/.test(basename)
  ) {
    return { kind: 'docker', language: 'docker' };
  }

  if (PACKAGE_FILES.has(basename)) {
    return withLanguage('package', languageForExtension(extension));
  }

  const extensionlessName = basename.replace(/\.(?:md|mdx|markdown|txt)$/, '');
  if (MARKDOWN_FILES.has(extensionlessName)) return { kind: 'markdown', language: 'markdown' };
  if (DOCUMENT_FILES.has(extensionlessName)) return { kind: 'document' };

  if (
    CONFIG_FILES.has(basename) ||
    /^(?:ts|js)config(?:\.[^.]+)*\.json$/.test(basename) ||
    /(?:^|\.)(?:config|rc)\.(?:[cm]?[jt]s|jsonc?|ya?ml|toml)$/.test(basename)
  ) {
    return withLanguage('config', languageForExtension(extension));
  }

  return EXTENSIONS[extension] ?? { kind: 'unknown' };
}
