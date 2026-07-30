const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  save,
  discard,
  decodeImageDataUrl,
  writeExclusive,
  evictToBudget,
  MAX_ATTACHMENT_BYTES,
  MAX_DATA_URL_BASE64_CHARS,
} = require('./attachments.cjs');

// 1x1 transparent PNG.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'attachments-test-'));
}

test('save writes the decoded bytes and returns a path inside the directory', async () => {
  const dir = await tempDir();
  const target = await save(dir, PNG_DATA_URL);
  assert.equal(path.dirname(target), path.resolve(dir));
  assert.match(path.basename(target), /^paste-\d+-[0-9a-f]{8}\.png$/);
  const written = await fsp.readFile(target);
  assert.deepEqual(written, Buffer.from(PNG_DATA_URL.split(',')[1], 'base64'));
});

test('save rejects payloads that are not supported image data URLs', async () => {
  const dir = await tempDir();
  await assert.rejects(() => save(dir, 'not-a-data-url'), /data URL/);
  await assert.rejects(() => save(dir, 'data:text/html;base64,PGI+'), /Unsupported image type/);
  await assert.rejects(() => save(dir, 'data:image/png;base64,'), /empty/);
});

test('save rejects payloads over the size cap', async () => {
  const dir = await tempDir();
  const big = `data:image/png;base64,${Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64')}`;
  await assert.rejects(() => save(dir, big), /size limit/);
});

test('decodeImageDataUrl normalizes jpeg to a jpg extension', () => {
  const { ext } = decodeImageDataUrl('data:image/jpeg;base64,/9j/4AAQ');
  assert.equal(ext, 'jpg');
});

test('discard removes a saved attachment and ignores missing files', async () => {
  const dir = await tempDir();
  const target = await save(dir, PNG_DATA_URL);
  await discard(dir, target);
  await assert.rejects(() => fsp.stat(target));
  await assert.doesNotReject(() => discard(dir, target));
});

test('discard refuses paths outside the attachments directory', async () => {
  const dir = await tempDir();
  await assert.rejects(() => discard(dir, dir), /outside the attachments/);
  await assert.rejects(() => discard(dir, path.join(dir, '..', 'other.png')), /outside/);
  await assert.rejects(() => discard(dir, '/tmp/whatever.png'), /outside/);
});

test('save rejects composer-accepted but unsupported types with an explicit message', async () => {
  const dir = await tempDir();
  // The composer paste filter accepts any image/* blob (e.g. SVG); at Original
  // fidelity the bytes reach us unconverted, so the refusal must say why.
  await assert.rejects(
    () => save(dir, 'data:image/svg+xml;base64,PHN2Zy8+'),
    /Unsupported image type: image\/svg\+xml \(supported: image\/png, image\/jpeg, image\/webp, image\/gif\)/,
  );
});

test('save rejects over-long encoded payloads before decoding them', async () => {
  const dir = await tempDir();
  // '!' is not in the base64 alphabet, so decoding would yield an empty
  // buffer; getting the size-limit error proves the check ran pre-decode.
  const huge = `data:image/png;base64,${'!'.repeat(MAX_DATA_URL_BASE64_CHARS + 4)}`;
  await assert.rejects(() => save(dir, huge), /size limit/);
});

test(
  'save and discard refuse a symlinked attachments root',
  { skip: process.platform === 'win32' },
  async () => {
    const parent = await tempDir();
    const realDir = path.join(parent, 'real');
    await fsp.mkdir(realDir);
    const link = path.join(parent, 'link');
    await fsp.symlink(realDir, link, 'dir');
    await assert.rejects(() => save(link, PNG_DATA_URL), /not a real directory/);
    await assert.rejects(() => discard(link, path.join(link, 'x.png')), /not a real directory/);
    // Nothing was written through the link.
    assert.deepEqual(await fsp.readdir(realDir), []);
  },
);

test(
  'save creates a missing attachments root with owner-only permissions',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = path.join(await tempDir(), 'nested', 'attachments');
    const target = await save(dir, PNG_DATA_URL);
    assert.equal(path.dirname(target), dir);
    const stats = await fsp.stat(dir);
    assert.equal(stats.mode & 0o777, 0o700);
  },
);

test('save sweeps stale attachments but keeps fresh ones', async () => {
  const dir = await tempDir();
  const stale = path.join(dir, 'paste-old.png');
  const fresh = path.join(dir, 'paste-new.png');
  await fsp.writeFile(stale, 'stale');
  await fsp.writeFile(fresh, 'fresh');
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fsp.utimes(stale, twoDaysAgo, twoDaysAgo);
  await save(dir, PNG_DATA_URL);
  await assert.rejects(() => fsp.stat(stale), /ENOENT/);
  assert.equal(await fsp.readFile(fresh, 'utf8'), 'fresh');
});

// mtimeMs controls eviction order, so stagger it explicitly rather than
// relying on write timing resolution.
async function writeAged(dir, name, bytes, ageMs) {
  const target = path.join(dir, name);
  await fsp.writeFile(target, Buffer.alloc(bytes));
  const mtime = new Date(Date.now() - ageMs);
  await fsp.utimes(target, mtime, mtime);
  return target;
}

test('evictToBudget removes oldest files until the incoming file fits', async () => {
  const dir = await tempDir();
  const oldest = await writeAged(dir, 'a.bin', 100, 3000);
  const middle = await writeAged(dir, 'b.bin', 100, 2000);
  const newest = await writeAged(dir, 'c.bin', 100, 1000);
  // 300 stored + 150 incoming vs a 300 budget: two oldest must go (300→100).
  await evictToBudget(dir, 150, 300);
  await assert.rejects(() => fsp.stat(oldest), /ENOENT/);
  await assert.rejects(() => fsp.stat(middle), /ENOENT/);
  await assert.doesNotReject(() => fsp.stat(newest));
});

test('evictToBudget leaves the directory alone when the budget already fits', async () => {
  const dir = await tempDir();
  const target = await writeAged(dir, 'a.bin', 100, 1000);
  await evictToBudget(dir, 150, 300);
  assert.equal((await fsp.stat(target)).size, 100);
});

test('writeExclusive retries with a fresh name and never clobbers an existing file', async () => {
  const dir = await tempDir();
  const names = ['clash.png', 'clash.png', 'fresh.png'];
  await fsp.writeFile(path.join(dir, 'clash.png'), 'occupied');
  const target = await writeExclusive(dir, () => names.shift(), Buffer.from('payload'));
  assert.equal(path.basename(target), 'fresh.png');
  assert.equal(await fsp.readFile(target, 'utf8'), 'payload');
  assert.equal(await fsp.readFile(path.join(dir, 'clash.png'), 'utf8'), 'occupied');
});

test('writeExclusive gives up after the attempt cap when every name collides', async () => {
  const dir = await tempDir();
  await fsp.writeFile(path.join(dir, 'taken.png'), 'occupied');
  await assert.rejects(
    () => writeExclusive(dir, () => 'taken.png', Buffer.from('x')),
    (error) => error.code === 'EEXIST',
  );
  assert.equal(await fsp.readFile(path.join(dir, 'taken.png'), 'utf8'), 'occupied');
});

test(
  'writeExclusive does not follow a pre-created symlink',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await tempDir();
    await fsp.writeFile(path.join(dir, 'victim.png'), 'victim');
    await fsp.symlink(path.join(dir, 'victim.png'), path.join(dir, 'link.png'));
    await assert.rejects(
      () => writeExclusive(dir, () => 'link.png', Buffer.from('x')),
      (error) => error.code === 'EEXIST',
    );
    assert.equal(await fsp.readFile(path.join(dir, 'victim.png'), 'utf8'), 'victim');
  },
);
