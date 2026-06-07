import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BROWSER_URL, isSelfBrowserUrl, safeBrowserUrl } from './browserUrlSafety';

test('safeBrowserUrl keeps the host app out of the browser pane', () => {
  assert.equal(
    safeBrowserUrl('http://127.0.0.1:1427/', 'http://127.0.0.1:1427'),
    DEFAULT_BROWSER_URL,
  );
  assert.equal(
    safeBrowserUrl('127.0.0.1:3000', 'http://127.0.0.1:1427'),
    'http://127.0.0.1:3000',
  );
});

test('isSelfBrowserUrl compares origins instead of exact paths', () => {
  assert.equal(isSelfBrowserUrl('http://127.0.0.1:1427/settings', 'http://127.0.0.1:1427'), true);
  assert.equal(isSelfBrowserUrl('https://example.com', 'http://127.0.0.1:1427'), false);
});

test('safeBrowserUrl drops Chromium internal error pages', () => {
  assert.equal(safeBrowserUrl('chrome-error://chromewebdata/', 'http://127.0.0.1:1427'), DEFAULT_BROWSER_URL);
});
