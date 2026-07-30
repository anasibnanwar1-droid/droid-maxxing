const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { save, discard, decodeImageDataUrl, MAX_ATTACHMENT_BYTES } = require('./attachments.cjs');

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
