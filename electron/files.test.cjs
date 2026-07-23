const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  listDirectory,
  readPreview,
  openDefault,
  revealInFolder,
  classifyByName,
  validateRelative,
  resolveWithin,
  LISTING_CAP_DEFAULT,
  TEXT_PREVIEW_CAP_BYTES,
} = require('./files.cjs');

// ---------------------------------------------------------------------------
// Temp workspace fixture used across the filesystem-touching tests.
// ---------------------------------------------------------------------------

let root;
let rootReal; // realpath of `root`, used for assertions that go through resolveWithin
let outside; // a directory outside `root` used for escape attempts

test.before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'files-root-'));
  rootReal = await fsp.realpath(root);
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'files-outside-'));
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.mkdir(path.join(root, 'empty'), { recursive: true });
  await fsp.writeFile(path.join(root, 'alpha.md'), '# Alpha\n');
  await fsp.writeFile(path.join(root, 'beta.txt'), 'beta contents\n');
  await fsp.writeFile(path.join(root, 'zeta.json'), JSON.stringify({ ok: true }));
  await fsp.writeFile(path.join(root, 'sub', 'nested.txt'), 'nested\n');
  // 1 MiB text file (well under the 5 MiB cap) for preview read.
  await fsp.writeFile(path.join(root, 'sub', 'big.txt'), 'a'.repeat(1024 * 1024));
  // Small binary image stub.
  await fs.promises.writeFile(
    path.join(root, 'sub', 'tiny.png'),
    Buffer.from([0x89, 0x5, 0x4e, 0x47]),
  );
  // A .json file whose contents are actually binary (NUL bytes) — used to
  // prove the text classifier refuses to inline packed binary payloads.
  await fs.promises.writeFile(
    path.join(root, 'sub', 'fake.json'),
    Buffer.concat([Buffer.from('head'), Buffer.from([0, 0, 0]), Buffer.from('tail')]),
  );
});

test.after(async () => {
  await Promise.all([
    fsp.rm(root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
  ]);
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

test('validateRelative rejects absolute paths, control chars, and traversal', () => {
  assert.ok(validateRelative(root, '').target === path.resolve(root));
  assert.throws(() => validateRelative(root, '/etc/passwd'), /absolute path rejected/);
  assert.throws(() => validateRelative(root, 'a\0b'), /invalid characters/);
  assert.throws(() => validateRelative(root, '../escape'), /escapes root/);
  assert.throws(() => validateRelative(root, 'sub/../../escape'), /escapes root/);
  // A single `..` that lands back inside root is fine.
  const ok = validateRelative(root, 'sub/../alpha.md');
  assert.equal(path.relative(path.resolve(root), ok.target), 'alpha.md');
});

test('validateRelative requires string inputs', () => {
  assert.throws(() => validateRelative(123, ''), /rootDir must be a string/);
  assert.throws(() => validateRelative(root, 42), /must be a string/);
});

test('resolveWithin rejects symlinks that escape the root', async () => {
  const linkPath = path.join(root, 'escape-link');
  await fsp.symlink(outside, linkPath, 'dir');
  await assert.rejects(() => resolveWithin(root, 'escape-link'), /escapes root/);
});

test('resolveWithin allows symlinks whose target stays inside the root', async () => {
  const innerLink = path.join(root, 'inner-link');
  await fsp.symlink(path.join(root, 'sub'), innerLink, 'dir');
  const resolved = await resolveWithin(root, 'inner-link/nested.txt');
  assert.equal(path.basename(resolved.target), 'nested.txt');
});

// ---------------------------------------------------------------------------
// listDirectory
// ---------------------------------------------------------------------------

test('listDirectory returns folders-first, alphabetical, non-recursive entries with metadata', async () => {
  const listing = await listDirectory(root);
  assert.equal(listing.capped, false);
  assert.equal(listing.permissionDenied, false);
  const kinds = listing.entries.map((e) => e.kind);
  // All directories must appear before any file in the sorted output.
  const firstFile = kinds.indexOf('file');
  const lastDir = kinds.lastIndexOf('directory');
  if (firstFile !== -1 && lastDir !== -1) {
    assert.ok(lastDir < firstFile, 'directories must sort before files');
  }
  const names = listing.entries.map((e) => e.name).sort();
  // The listing is not recursive, so nested.txt under sub/ must not appear.
  assert.ok(!names.includes('nested.txt'));
  // alpha.md, beta.txt, zeta.json live at the top level.
  assert.ok(names.includes('alpha.md'));
  // Each entry must carry kind, size, and mtimeMs.
  for (const entry of listing.entries) {
    assert.ok(entry.kind === 'directory' || entry.kind === 'file');
    assert.equal(typeof entry.size, 'number');
    assert.equal(typeof entry.mtimeMs, 'number');
  }
});

test('listDirectory accepts a relative subpath', async () => {
  const listing = await listDirectory(root, 'sub');
  const names = listing.entries.map((e) => e.name);
  assert.ok(names.includes('nested.txt'));
  assert.ok(names.includes('big.txt'));
});

test('listDirectory rejects traversal and out-of-root targets', async () => {
  await assert.rejects(() => listDirectory(root, '../'), /escapes root/);
  await assert.rejects(() => listDirectory(root, 'escape-link'), /escapes root/);
});

test('listDirectory rejects non-directory targets', async () => {
  await assert.rejects(() => listDirectory(root, 'alpha.md'), { code: 'ENOTDIR' });
});

test('listDirectory respects the cap and reports truncation', async () => {
  // Build a directory with more entries than the requested cap.
  const capDir = path.join(root, 'capped-dir');
  await fsp.mkdir(capDir, { recursive: true });
  for (let i = 0; i < 5; i += 1) {
    await fsp.writeFile(path.join(capDir, `f${i}.txt`), String(i));
  }
  const listing = await listDirectory(root, 'capped-dir', { cap: 2 });
  assert.equal(listing.entries.length, 2);
  assert.equal(listing.capped, true);
  assert.ok(listing.totalSeen >= 5);
});

test(`listDirectory default cap is ${LISTING_CAP_DEFAULT}`, () => {
  assert.equal(LISTING_CAP_DEFAULT, 1000);
});

// ---------------------------------------------------------------------------
// readPreview
// ---------------------------------------------------------------------------

test('readPreview returns UTF-8 text for text files under the cap', async () => {
  const payload = await readPreview(root, 'beta.txt');
  assert.equal(payload.category, 'text');
  assert.equal(payload.previewable, true);
  assert.equal(payload.encoding, 'utf8');
  assert.equal(payload.text, 'beta contents\n');
  assert.equal(payload.oversize, undefined);
  assert.equal(payload.sizeCapBytes, TEXT_PREVIEW_CAP_BYTES);
  assert.equal(payload.path.relative, 'beta.txt');
});

test('readPreview returns a Buffer (not base64) for binary previewable categories', async () => {
  const payload = await readPreview(root, 'sub/tiny.png');
  assert.equal(payload.category, 'image');
  assert.equal(payload.encoding, 'binary');
  assert.ok(Buffer.isBuffer(payload.data), 'data should be a Buffer');
  assert.deepEqual(Array.from(payload.data.slice(0, 4)), [0x89, 0x05, 0x4e, 0x47]);
  assert.equal(payload.oversize, undefined);
});

test('readPreview short-circuits external categories without reading bytes', async () => {
  // Create an archive-stub file under root.
  const archivePath = path.join(root, 'bundle.zip');
  await fsp.writeFile(archivePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const payload = await readPreview(root, 'bundle.zip');
  assert.equal(payload.category, 'external');
  assert.equal(payload.previewable, false);
  assert.equal(payload.reason, 'external-fallback');
  assert.equal(payload.data, undefined);
  assert.equal(payload.text, undefined);
});

test('readPreview reports oversize files without reading their payload', async () => {
  // Write a file just past the text cap. (We do not inflate a real 5 MiB
  // file here; instead we temporarily shrink behaviour by writing a 6 MiB
  // sparse text file.)
  const bigPath = path.join(root, 'oversize.txt');
  const fh = await fsp.open(bigPath, 'w');
  // Allocate a file larger than the text cap using truncate (sparse on most FS).
  await fh.truncate(TEXT_PREVIEW_CAP_BYTES + 1);
  await fh.close();
  const payload = await readPreview(root, 'oversize.txt');
  assert.equal(payload.category, 'text');
  assert.equal(payload.oversize, true);
  assert.equal(payload.text, undefined);
  assert.ok(payload.totalSize > TEXT_PREVIEW_CAP_BYTES);
});

test('readPreview refuses to inline a binary payload masquerading as text', async () => {
  const payload = await readPreview(root, 'sub/fake.json');
  assert.equal(payload.category, 'external');
  assert.equal(payload.previewable, false);
  assert.equal(payload.reason, 'binary-in-text-extension');
  assert.equal(payload.text, undefined);
});

test('readPreview rejects non-file targets and path escapes', async () => {
  await assert.rejects(() => readPreview(root, 'sub'), { code: 'EINVAL' });
  await assert.rejects(() => readPreview(root, '../outside'), /escapes root/);
  await assert.rejects(() => readPreview(root, 'escape-link'), /escapes root/);
});

test('readPreview rejects traversal into a symlink escape', async () => {
  const fileLink = path.join(root, 'file-escape');
  await fsp.symlink(path.join(outside, 'secret.txt'), fileLink, 'file');
  await assert.rejects(() => readPreview(root, 'file-escape'), /escapes root/);
});

// ---------------------------------------------------------------------------
// openDefault / revealInFolder with injected shell doubles
// ---------------------------------------------------------------------------

test('openDefault invokes the injected shell.openPath and refuses missing shell', async () => {
  const calls = [];
  const shell = {
    async openPath(target) {
      calls.push(target);
      return ''; // Electron returns an empty string on success
    },
    async showItemInFolder() {},
  };
  const result = await openDefault(root, 'alpha.md', shell);
  assert.equal(result.opened, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], path.join(rootReal, 'alpha.md'));

  // Missing shell helper should throw a descriptive error instead of silently
  // succeeding.
  await assert.rejects(() => openDefault(root, 'alpha.md', {}), /shell.openPath is required/);
});

test('openDefault surfaces openPath error strings from Electron', async () => {
  const shell = {
    async openPath() {
      return 'Failed to open';
    },
    async showItemInFolder() {},
  };
  await assert.rejects(() => openDefault(root, 'alpha.md', shell), /Failed to open/);
});

test('openDefault rejects directories and path escapes', async () => {
  const shell = {
    async openPath() {
      return '';
    },
    async showItemInFolder() {},
  };
  await assert.rejects(() => openDefault(root, 'sub', shell), { code: 'EINVAL' });
  await assert.rejects(() => openDefault(root, '../outside', shell), /escapes root/);
});

test('revealInFolder invokes the injected shell.showItemInFolder for files and directories', async () => {
  const revealed = [];
  const shell = {
    async openPath() {
      return '';
    },
    async showItemInFolder(target) {
      revealed.push(target);
    },
  };
  const fileResult = await revealInFolder(root, 'alpha.md', shell);
  assert.equal(fileResult.revealed, true);
  assert.equal(revealed.length, 1);

  const dirResult = await revealInFolder(root, 'sub', shell);
  assert.equal(dirResult.revealed, true);
  assert.equal(revealed.length, 2);

  await assert.rejects(
    () => revealInFolder(root, 'alpha.md', {}),
    /shell.showItemInFolder is required/,
  );
  await assert.rejects(() => revealInFolder(root, '../outside', shell), /escapes root/);
});

// ---------------------------------------------------------------------------
// Classification parity smoke (mirrors src/lib/filePreview.ts)
// ---------------------------------------------------------------------------

test('classifyByName mirrors the renderer-side categories', () => {
  assert.equal(classifyByName('readme.md'), 'text');
  assert.equal(classifyByName('data.csv'), 'text');
  assert.equal(classifyByName('schema.json'), 'text');
  assert.equal(classifyByName('Dockerfile'), 'text');
  assert.equal(classifyByName('.gitignore'), 'text');
  assert.equal(classifyByName('logo.png'), 'image');
  assert.equal(classifyByName('photo.JPG'), 'image');
  assert.equal(classifyByName('paper.pdf'), 'pdf');
  assert.equal(classifyByName('report.docx'), 'docx');
  assert.equal(classifyByName('sheet.xlsx'), 'xlsx');
  // External fallbacks
  assert.equal(classifyByName('old.doc'), 'external');
  assert.equal(classifyByName('macro.docm'), 'external');
  assert.equal(classifyByName('archive.zip'), 'external');
  assert.equal(classifyByName('binary.exe'), 'external');
  assert.equal(classifyByName('noextension'), 'external');
});
