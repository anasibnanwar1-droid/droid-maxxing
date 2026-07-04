import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('PreviewServer serves a registered file and blocks unknown ids + traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'droidex-preview-test-'));
  await writeFile(join(dir, 'index.html'), '<h1>brand book</h1>', 'utf8');
  const server = new PreviewServer();
  await server.start();
  try {
    const url = server.register('abc', dir);

    const ok = await get(url);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /brand book/);

    const unknown = await get(url.replace('/abc/', '/nope/'));
    assert.equal(unknown.status, 404);

    const base = url.replace(/\/abc\/$/, '');
    const traversal = await get(`${base}/abc/..%2f..%2f..%2fetc%2fpasswd`);
    assert.ok(traversal.status === 403 || traversal.status === 404, 'traversal is rejected');
  } finally {
    await server.close();
  }
});
