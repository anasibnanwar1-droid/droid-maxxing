/**
 * Secure root-bound Files-domain backend helpers.
 *
 * Every operation takes a canonical mission root plus a relative path and
 * refuses to follow absolute paths, traversal segments, out-of-root targets,
 * or symlink escapes. The resolved target must additionally be a regular file
 * (or directory for listDirectory) before any bytes are read.
 *
 * This module is intentionally free of `require('electron')` at module load
 * so it can be unit-tested under plain Node. Callers in the main process
 * (electron/main.cjs) inject the Electron `shell` object when wiring up the
 * `openDefault` / `revealInFolder` IPC handlers, which keeps these helpers
 * deterministic and testable.
 *
 * Exported contract (consumed by the renderer via IPC):
 *   listDirectory(rootDir, relativePath?, options?) -> Promise<DirectoryListing>
 *   readPreview(rootDir, relativePath, options?)    -> Promise<PreviewPayload>
 *   openDefault(rootDir, relativePath, shell)       -> Promise<OpenResult>
 *   revealInFolder(rootDir, relativePath, shell)    -> Promise<OpenResult>
 *   classifyByName(name)                             -> PreviewCategory
 *
 * The classification tables mirror src/lib/filePreview.ts. Keep them in sync;
 * the paired unit tests exercise the shared edge cases.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const LISTING_CAP_DEFAULT = 1000;
const LISTING_CAP_MAX = 5000;
const TEXT_PREVIEW_CAP_BYTES = 5 * 1024 * 1024; // 5 MiB
const BINARY_PREVIEW_CAP_BYTES = 25 * 1024 * 1024; // 25 MiB
// Number of leading bytes inspected to detect misclassified binary content
// masquerading as text (e.g. NUL bytes from a `.json` that is actually a
// packed binary). Reading the whole file first would defeat the size cap.
const TEXT_BINARY_PROBE_BYTES = 8192;

const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'log',
  'md',
  'markdown',
  'mdx',
  'json',
  'json5',
  'jsonc',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'xhtml',
  'css',
  'scss',
  'sass',
  'less',
  'styl',
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
  'toml',
  'ini',
  'cfg',
  'conf',
  'config',
  'properties',
  'env',
  'editorconfig',
  'sql',
  'graphql',
  'gql',
  'diff',
  'patch',
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

function assertString(value, name) {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
}

function extensionOf(name) {
  const lower = String(name).toLowerCase();
  const base = lower.split(/[\\/]/).pop() ?? lower;
  if (TEXT_FILENAMES.has(base)) return base;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    // No extension. For dotfiles such as ".gitignore", strip the leading dot
    // so TEXT_FILENAMES can match "gitignore" without storing the dot.
    return base.startsWith('.') ? base.slice(1) : base;
  }
  return base.slice(dot + 1);
}

function classifyByName(name) {
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (DOCX_EXTENSIONS.has(ext)) return 'docx';
  if (XLSX_EXTENSIONS.has(ext)) return 'xlsx';
  return 'external';
}

function previewSizeCap(category) {
  return category === 'text' ? TEXT_PREVIEW_CAP_BYTES : BINARY_PREVIEW_CAP_BYTES;
}

/**
 * Lexically validates that `relativePath` cannot escape `rootDir`. Returns the
 * resolved absolute target plus the canonical relative segment. Does NOT touch
 * the filesystem, so it is safe to use as a pre-check before any I/O.
 *
 * Rejects:
 *   - non-string inputs
 *   - absolute paths (including Windows drive roots)
 *   - NUL / control characters
 *   - segments that resolve above the root via `..`
 */
function validateRelative(rootDir, relativePath) {
  assertString(rootDir, 'rootDir');
  const root = path.resolve(rootDir);
  if (relativePath === undefined || relativePath === null || relativePath === '') {
    return { root, target: root, relative: '' };
  }
  if (typeof relativePath !== 'string') {
    throw new Error('relativePath must be a string');
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error('absolute path rejected');
  }
  if ([...relativePath].some((character) => character.charCodeAt(0) <= 0x1f)) {
    throw new Error('invalid characters in path');
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error('path escapes root');
  }
  return { root, target, relative };
}

/**
 * Resolves `rootDir`/`relativePath` against the real filesystem and guarantees
 * the target's realpath stays inside the realpath of the root. This catches
 * symlink escapes that the lexical check cannot see. The target must already
 * exist (realpath throws ENOENT otherwise); callers that need to handle
 * missing paths should catch that code explicitly.
 */
async function resolveWithin(rootDir, relativePath) {
  const lexical = validateRelative(rootDir, relativePath);
  const rootReal = await fsp.realpath(lexical.root);
  // Re-run the lexical check against the real root in case the supplied root
  // contained symlink segments that change which directory we actually land in.
  const targetLexical = path.resolve(rootReal, lexical.relative);
  let targetReal;
  try {
    targetReal = await fsp.realpath(targetLexical);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Broken or dangling symlink: realpath can no longer resolve it, so
      // walk each component with readlink to still catch escapes.
      await assertNoSymlinkEscape(rootReal, targetLexical);
      targetReal = targetLexical;
    } else {
      throw err;
    }
  }
  const relativeReal = path.relative(rootReal, targetReal);
  if (relativeReal !== '' && (relativeReal.startsWith('..') || path.isAbsolute(relativeReal))) {
    throw new Error('symlink escapes root');
  }
  return { root: rootReal, target: targetReal, relative: relativeReal };
}

/**
 * Walks each component of `targetLexical` and rejects any symlink whose
 * readlink target resolves outside `rootReal`. Used when realpath fails
 * (broken symlinks) so escape attempts cannot hide behind ENOENT.
 */
async function assertNoSymlinkEscape(rootReal, targetLexical) {
  const segments = path.relative(rootReal, targetLexical).split(path.sep).filter(Boolean);
  let current = rootReal;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    let stat;
    try {
      stat = await fsp.lstat(candidate);
    } catch (err) {
      if (err.code === 'ENOENT') return; // missing component — let caller surface
      throw err;
    }
    if (stat.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(candidate);
      const resolved = path.isAbsolute(linkTarget) ? linkTarget : path.resolve(current, linkTarget);
      const rel = path.relative(rootReal, resolved);
      if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
        throw new Error('symlink escapes root');
      }
      current = resolved;
    } else {
      current = candidate;
    }
  }
}

function compareEntries(a, b) {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Non-recursive directory listing with per-entry metadata.
 *
 * Returns folders-first, alphabetical entries capped at `options.cap`
 * (default 1000, hard-clamped to LISTING_CAP_MAX). Each entry carries its
 * kind, byte size, and mtime in milliseconds since the epoch. The payload
 * reports whether the cap truncated the result so the UI can warn the user.
 */
async function listDirectory(rootDir, relativePath, options = {}) {
  const cap = clampCap(options.cap);
  const resolved = await resolveWithin(rootDir, relativePath);
  const stat = await fsp.lstat(resolved.target);
  if (!stat.isDirectory()) {
    const err = new Error('not a directory');
    err.code = 'ENOTDIR';
    throw err;
  }
  let dirents;
  try {
    dirents = await fsp.readdir(resolved.target, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return {
        root: resolved.root,
        relative: resolved.relative,
        entries: [],
        totalSeen: 0,
        capped: false,
        permissionDenied: true,
      };
    }
    throw err;
  }
  const entries = [];
  let totalSeen = 0;
  let capped = false;
  for (const dirent of dirents) {
    // Skip socket / FIFO / device / unknown node types entirely; only files
    // and directories are meaningful in the Files tab.
    if (!dirent.isDirectory() && !dirent.isFile()) continue;
    const childPath = path.join(resolved.target, dirent.name);
    let size = 0;
    let mtimeMs = 0;
    try {
      const childStat = await fsp.lstat(childPath);
      size = childStat.size;
      mtimeMs = Math.floor(Number(childStat.mtimeMs) || 0);
    } catch {
      // Lstat failure for a single child should not poison the whole listing.
      size = 0;
      mtimeMs = 0;
    }
    totalSeen += 1;
    if (entries.length >= cap) {
      capped = true;
      continue;
    }
    entries.push({
      name: dirent.name,
      kind: dirent.isDirectory() ? 'directory' : 'file',
      size,
      mtimeMs,
    });
  }
  entries.sort(compareEntries);
  return {
    root: resolved.root,
    relative: resolved.relative,
    entries,
    totalSeen,
    capped,
    permissionDenied: false,
  };
}

function clampCap(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return LISTING_CAP_DEFAULT;
  return Math.min(Math.floor(n), LISTING_CAP_MAX);
}

/**
 * Reads a preview payload for a single file under the mission root.
 *
 * Behaviour by category:
 *   - text:  returns `{ text }` decoded as UTF-8, capped at TEXT_PREVIEW_CAP_BYTES.
 *   - image/pdf/docx/xlsx: returns `{ data: Buffer }` capped at BINARY_PREVIEW_CAP_BYTES.
 *   - external: no payload is read; the UI should fall back to opening the file
 *     in its OS default application. Returning early avoids hauling large
 *     macro-enabled or legacy payloads through IPC.
 *
 * Files larger than the category cap return `{ oversize: true }` with metadata
 * and no payload, so the UI can prompt the user to open externally rather than
 * silently truncating.
 */
async function readPreview(rootDir, relativePath) {
  const resolved = await resolveWithin(rootDir, relativePath);
  const stat = await fsp.lstat(resolved.target);
  if (!stat.isFile()) {
    const err = new Error('not a file');
    err.code = 'EINVAL';
    throw err;
  }
  const name = path.basename(resolved.target);
  const category = classifyByName(name);
  const totalSize = stat.size;
  const sizeCapBytes = previewSizeCap(category);

  if (category === 'external') {
    return {
      category,
      totalSize,
      sizeCapBytes,
      previewable: false,
      reason: 'external-fallback',
      path: { root: resolved.root, relative: resolved.relative },
    };
  }

  if (totalSize > sizeCapBytes) {
    return {
      category,
      totalSize,
      sizeCapBytes,
      previewable: true,
      oversize: true,
      path: { root: resolved.root, relative: resolved.relative },
    };
  }

  if (category === 'text') {
    const buffer = await fsp.readFile(resolved.target);
    if (containsBinaryProbe(buffer)) {
      // A file with a text extension that is actually binary (NUL bytes in the
      // leading window) would render as garbage and likely contains a packed
      // payload. Refuse to inline it and hand off to the OS default.
      return {
        category: 'external',
        totalSize,
        sizeCapBytes: BINARY_PREVIEW_CAP_BYTES,
        previewable: false,
        reason: 'binary-in-text-extension',
        path: { root: resolved.root, relative: resolved.relative },
      };
    }
    return {
      category: 'text',
      totalSize,
      sizeCapBytes,
      previewable: true,
      encoding: 'utf8',
      text: buffer.toString('utf8'),
      path: { root: resolved.root, relative: resolved.relative },
    };
  }

  const data = await fsp.readFile(resolved.target);
  return {
    category,
    totalSize,
    sizeCapBytes,
    previewable: true,
    encoding: 'binary',
    data,
    path: { root: resolved.root, relative: resolved.relative },
  };
}

function containsBinaryProbe(buffer) {
  const len = Math.min(buffer.length, TEXT_BINARY_PROBE_BYTES);
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Opens a file in the OS default application. The Electron `shell` object is
 * injected by the caller so this function remains testable without Electron.
 * `shell` is expected to expose `openPath(target) -> Promise<string>` (an
 * empty string on success, per Electron's contract).
 */
async function openDefault(rootDir, relativePath, shell) {
  const resolved = await resolveWithin(rootDir, relativePath);
  const stat = await fsp.lstat(resolved.target);
  if (!stat.isFile()) {
    const err = new Error('not a file');
    err.code = 'EINVAL';
    throw err;
  }
  const openPath = shell?.openPath;
  if (typeof openPath !== 'function') {
    throw new Error('shell.openPath is required');
  }
  const openError = await openPath(resolved.target);
  if (typeof openError === 'string' && openError !== '') {
    throw new Error(openError);
  }
  return { opened: true, target: resolved.target, root: resolved.root };
}

/**
 * Reveals a file in the platform file manager (Finder / Explorer / etc.).
 * `shell.showItemInFolder(target)` is synchronous in Electron and returns
 * void; we still `await` it so test doubles can be async.
 */
async function revealInFolder(rootDir, relativePath, shell) {
  const resolved = await resolveWithin(rootDir, relativePath);
  // Allow reveal on directories too: selecting a folder in Finder is a normal
  // Files-tab interaction. We only require the path to exist.
  const showItem = shell?.showItemInFolder;
  if (typeof showItem !== 'function') {
    throw new Error('shell.showItemInFolder is required');
  }
  await showItem(resolved.target);
  return { revealed: true, target: resolved.target, root: resolved.root };
}

module.exports = {
  listDirectory,
  readPreview,
  openDefault,
  revealInFolder,
  classifyByName,
  validateRelative,
  resolveWithin,
  // constants (also useful to consumers / tests)
  LISTING_CAP_DEFAULT,
  LISTING_CAP_MAX,
  TEXT_PREVIEW_CAP_BYTES,
  BINARY_PREVIEW_CAP_BYTES,
};
