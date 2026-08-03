import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PreviewServer } from './previewServer.js';

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

test('PreviewServer shares one in-flight start across concurrent callers', async () => {
  let createdServers = 0;
  const server = new PreviewServer(createReadStream, (listener) => {
    createdServers += 1;
    return http.createServer(listener);
  });

  await Promise.all([server.start(), server.start(), server.start()]);
  assert.equal(createdServers, 1);
  await server.close();
});

test('PreviewServer serves a registered file and blocks unknown ids + traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'droidex-preview-test-'));
  await writeFile(join(dir, 'index.html'), '<h1>brand book</h1>', 'utf8');
  await writeFile(join(dir, '.env'), 'SECRET=not-for-preview', 'utf8');
  const server = new PreviewServer();
  await server.start();
  try {
    const url = await server.register('abc', dir, ['index.html']);

    const ok = await get(url);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /brand book/);

    const unknown = await get(url.replace('/abc/', '/nope/'));
    assert.equal(unknown.status, 404);

    const unregisteredSibling = await get(`${url}.env`);
    assert.equal(unregisteredSibling.status, 404);

    const base = url.replace(/\/abc\/$/, '');
    const traversal = await get(`${base}/abc/..%2f..%2f..%2fetc%2fpasswd`);
    assert.ok(traversal.status === 403 || traversal.status === 404, 'traversal is rejected');
  } finally {
    await server.close();
  }
});

test('PreviewServer rejects an explicitly registered symlink outside its root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'droidex-preview-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'droidex-preview-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
  await symlink(join(outside, 'secret.txt'), join(dir, 'linked.txt'));

  const server = new PreviewServer();
  await assert.rejects(
    server.register('linked', dir, ['linked.txt']),
    /outside its registered root/,
  );
});

test('PreviewServer contains asynchronous stream failures and remains usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'droidex-preview-stream-'));
  await writeFile(join(dir, 'index.html'), 'healthy', 'utf8');
  let shouldFail = true;
  const server = new PreviewServer((path) => {
    if (!shouldFail) return createReadStream(path);
    shouldFail = false;
    return new Readable({
      read() {
        this.destroy(new Error('simulated read failure'));
      },
    });
  });
  await server.start();
  try {
    const url = await server.register('stream', dir, ['index.html']);
    await assert.rejects(get(url));

    const recovered = await get(url);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body, 'healthy');
  } finally {
    await server.close();
  }
});
