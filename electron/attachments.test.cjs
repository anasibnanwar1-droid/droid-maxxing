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
  withSaveLock,
  MAX_ATTACHMENT_BYTES,
  MAX_DATA_URL_BASE64_CHARS,
  EVICTION_GRACE_MS,
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
  // Ages beyond the eviction grace: only files too old to back an unsent
  // prompt are eligible for eviction.
  const oldest = await writeAged(dir, 'a.bin', 100, 3 * EVICTION_GRACE_MS);
  const middle = await writeAged(dir, 'b.bin', 100, 2 * EVICTION_GRACE_MS);
  const newest = await writeAged(dir, 'c.bin', 100, 1.5 * EVICTION_GRACE_MS);
  // 300 stored + 150 incoming vs a 300 budget: two oldest must go (300→100).
  assert.equal(await evictToBudget(dir, 150, 300), true);
  await assert.rejects(() => fsp.stat(oldest), /ENOENT/);
  await assert.rejects(() => fsp.stat(middle), /ENOENT/);
  await assert.doesNotReject(() => fsp.stat(newest));
});

test('evictToBudget leaves the directory alone when the budget already fits', async () => {
  const dir = await tempDir();
  const target = await writeAged(dir, 'a.bin', 100, 1000);
  assert.equal(await evictToBudget(dir, 150, 300), true);
  assert.equal((await fsp.stat(target)).size, 100);
});

test('evictToBudget preserves files young enough to back an unsent prompt', async () => {
  const dir = await tempDir();
  // A queued prompt references its images by path until the agent consumes
  // the @-mention, so a file inside the grace window must survive eviction
  // even when the directory is over budget.
  const young = await writeAged(dir, 'young.bin', 100, 1000);
  assert.equal(await evictToBudget(dir, 250, 300), false);
  assert.equal((await fsp.stat(young)).size, 100);
});

test('save rejects instead of evicting attachments young enough to be in use', async () => {
  const dir = await tempDir();
  const young = await writeAged(dir, 'young.bin', 100, 1000);
  // 100 stored + the incoming image vs a 100 budget: only a young file could
  // make room, so the save must fail loudly rather than break a prompt.
  await assert.rejects(() => save(dir, PNG_DATA_URL, { budgetBytes: 100 }), /full/);
  assert.equal((await fsp.stat(young)).size, 100);
});

test('save evicts aged attachments to make room for the incoming image', async () => {
  const dir = await tempDir();
  const old = await writeAged(dir, 'old.bin', 100, 2 * EVICTION_GRACE_MS);
  const target = await save(dir, PNG_DATA_URL, { budgetBytes: 100 });
  await assert.rejects(() => fsp.stat(old), /ENOENT/);
  assert.equal(path.dirname(target), path.resolve(dir));
});

test('withSaveLock serializes tasks per directory and survives failures', async () => {
  const dir = await tempDir();
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = withSaveLock(dir, async () => {
    order.push('first:start');
    await gate;
    order.push('first:end');
  });
  const second = withSaveLock(dir, async () => {
    order.push('second');
  });
  const third = withSaveLock(dir, async () => {
    throw new Error('boom');
  });
  const fourth = withSaveLock(dir, async () => {
    order.push('fourth');
  });
  // Without serialization the later tasks would have run before the gate
  // released; yield so any such interleaving would be recorded.
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  await second;
  await assert.rejects(() => third, /boom/);
  await fourth;
  assert.deepEqual(order, ['first:start', 'first:end', 'second', 'fourth']);
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
