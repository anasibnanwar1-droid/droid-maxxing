import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrowserUrl } from './browserUrl.js';

test('normalizeBrowserUrl keeps explicit browser URLs', () => {
  assert.equal(normalizeBrowserUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizeBrowserUrl('http://127.0.0.1:1420/'), 'http://127.0.0.1:1420/');
  assert.equal(normalizeBrowserUrl('about:blank'), 'about:blank');
});

test('normalizeBrowserUrl makes bare domains and localhost loadable', () => {
  assert.equal(normalizeBrowserUrl('skeina.tech'), 'https://skeina.tech');
  assert.equal(normalizeBrowserUrl('localhost:1420'), 'http://localhost:1420');
  assert.equal(normalizeBrowserUrl('//example.com/path'), 'https://example.com/path');
  assert.equal(normalizeBrowserUrl('::1:8080/dev'), 'http://[::1]:8080/dev');
});
