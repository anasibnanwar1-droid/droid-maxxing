import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWebSearchTool,
  isWebFetchTool,
  parseWebSearch,
  parseWebFetch,
  formatCharCount,
  webSourceName,
  faviconUrl,
  toolArgStringArray,
} from './tools';

const SAMPLE = `Web Search Results for: "electron auto update best practices 2026"

**Electron | Sentry for Electron**
   URL: https://docs.sentry.io/platforms/javascript/guides/electron/
   
   Learn how to manually set up Sentry in your Electron app and capture your first errors.

---

**GitHub - getsentry/sentry-electron: The official Sentry SDK for ...**
   URL: https://github.com/getsentry/sentry-electron
   
   The official Sentry SDK for Electron. Contribute to getsentry/sentry-electron development by creating an account on GitHub.
Found 2 results`;

test('isWebSearchTool matches WebSearch tool names only', () => {
  assert.equal(isWebSearchTool('WebSearch'), true);
  assert.equal(isWebSearchTool('web_search'), true);
  assert.equal(isWebSearchTool('FetchUrl'), false);
  assert.equal(isWebSearchTool(undefined), false);
});

test('isWebFetchTool matches fetch tools and excludes web search', () => {
  assert.equal(isWebFetchTool('FetchUrl'), true);
  assert.equal(isWebFetchTool('WebFetch'), true);
  assert.equal(isWebFetchTool('browse_page'), true);
  assert.equal(isWebFetchTool('WebSearch'), false);
  assert.equal(isWebFetchTool('web_search'), false);
  assert.equal(isWebFetchTool('Grep'), false);
  assert.equal(isWebFetchTool(undefined), false);
});

test('parseWebSearch extracts query, count and result blocks', () => {
  const { query, count, results } = parseWebSearch(SAMPLE);
  assert.equal(query, 'electron auto update best practices 2026');
  assert.equal(count, 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Electron | Sentry for Electron');
  assert.equal(results[0].url, 'https://docs.sentry.io/platforms/javascript/guides/electron/');
  assert.match(results[0].snippet, /manually set up Sentry/);
  assert.equal(results[1].url, 'https://github.com/getsentry/sentry-electron');
});

test('parseWebSearch returns no results for an empty search', () => {
  const { count, results } = parseWebSearch(
    'Web Search Results for: "nothing here"\n\nNo results found.',
  );
  assert.equal(results.length, 0);
  assert.equal(count, undefined);
});

test('parseWebFetch prefers the arg URL and a markdown title', () => {
  const page = parseWebFetch(
    '# Electron auto-update\n\nShip updates safely with differential releases.\n\nMore detail here.',
    'https://www.electronjs.org/docs/latest/tutorial/updates',
  );
  assert.equal(page.url, 'https://www.electronjs.org/docs/latest/tutorial/updates');
  assert.equal(page.title, 'Electron auto-update');
  assert.match(page.body, /Ship updates safely/);
  assert.ok(!page.body.startsWith('#'));
  assert.ok(page.chars > 20);
  assert.equal(page.truncatedChars, null);
});

test('parseWebFetch reads Title/URL meta lines and strips the truncation sentinel', () => {
  const page = parseWebFetch(
    'Title: Sentry for Electron\nURL: https://docs.sentry.io/platforms/javascript/guides/electron/\n\nLearn how to set up Sentry.\n\n[truncated 4096 chars]',
  );
  assert.equal(page.title, 'Sentry for Electron');
  assert.equal(page.url, 'https://docs.sentry.io/platforms/javascript/guides/electron/');
  assert.equal(page.body, 'Learn how to set up Sentry.');
  assert.equal(page.truncatedChars, 4096);
});

test('formatCharCount uses compact k labels', () => {
  assert.equal(formatCharCount(42), '42');
  assert.equal(formatCharCount(1240), '1.2k');
  assert.equal(formatCharCount(10_500), '11k');
});

test('webSourceName derives a capitalized registrable label', () => {
  assert.equal(webSourceName('https://www.theregister.com/2026/01/01/x'), 'Theregister');
  assert.equal(webSourceName('https://docs.sentry.io/platforms'), 'Sentry');
  assert.equal(webSourceName('not a url'), 'not a url');
});

test('faviconUrl builds a favicon endpoint for a valid URL', () => {
  assert.match(faviconUrl('https://github.com/x') ?? '', /favicons.*domain=github\.com/);
  assert.equal(faviconUrl('not a url'), undefined);
});

test('toolArgStringArray reads a string array arg, ignoring non-strings', () => {
  assert.deepEqual(
    toolArgStringArray({ includeDomains: ['x.com', 1, 'y.com'] }, 'includeDomains'),
    ['x.com', 'y.com'],
  );
  assert.deepEqual(toolArgStringArray({}, 'includeDomains'), []);
});
