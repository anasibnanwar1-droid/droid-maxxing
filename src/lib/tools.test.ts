import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWebSearchTool,
  isWebFetchTool,
  parseWebSearch,
  parseWebFetch,
  looksLikeHtml,
  formatCharCount,
  webSourceName,
  faviconUrl,
  toolArgStringArray,
  latestTodoSnapshot,
  activeTodoIndex,
  isChildSessionTool,
  toolMeta,
  CAT_LABEL,
  type TodoItem,
} from './tools';
import type { TranscriptEvent } from '../types/bridge';

function todoCall(id: string, toolArgs: unknown): TranscriptEvent {
  return {
    id,
    appSessionId: 'm',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: 0,
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs,
  } as TranscriptEvent;
}

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

test('isWebSearchTool covers engine names, MCP prefixes, and web queries', () => {
  assert.equal(isWebSearchTool('brave_web_search'), true);
  assert.equal(isWebSearchTool('brave-web-search'), true);
  assert.equal(isWebSearchTool('mcp__tavily__tavily-search'), true);
  assert.equal(isWebSearchTool('google'), true);
  assert.equal(isWebSearchTool('web_query'), true);
  assert.equal(isWebSearchTool('websearch'), true);
  // A plain local search stays false — no web/engine signal.
  assert.equal(isWebSearchTool('Search'), false);
  assert.equal(isWebSearchTool('Grep'), false);
  assert.equal(isWebSearchTool('search_files'), false);
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

test('isWebFetchTool covers separators, MCP prefixes, and url verbs', () => {
  assert.equal(isWebFetchTool('fetch_url'), true);
  assert.equal(isWebFetchTool('open_url'), true);
  assert.equal(isWebFetchTool('getURL'), true);
  assert.equal(isWebFetchTool('visit_site'), true);
  assert.equal(isWebFetchTool('loadWebPage'), true);
  assert.equal(isWebFetchTool('web_page'), true);
  assert.equal(isWebFetchTool('http_request'), true);
  assert.equal(isWebFetchTool('mcp__fetch__fetch'), true);
  assert.equal(isWebFetchTool('server___FetchUrl'), true);
  // No fetch/url signal → stays a generic tool line.
  assert.equal(isWebFetchTool('Read'), false);
  assert.equal(isWebFetchTool('TodoWrite'), false);
  assert.equal(isWebFetchTool('mcp__figma__get_design'), false);
});

test('isWebFetchTool never matches browser-automation tools', () => {
  assert.equal(isWebFetchTool('droidmaxx-browser___browser_open'), false);
  assert.equal(isWebFetchTool('browser_navigate'), false);
  assert.equal(isWebFetchTool('browser_click'), false);
});

test('looksLikeHtml detects raw HTML but not markdown prose', () => {
  assert.equal(looksLikeHtml('<!DOCTYPE html>\n<html><body>hi</body></html>'), true);
  assert.equal(
    looksLikeHtml(
      '<div class="a"><p>one</p><p>two</p><span>three</span><br/><hr/><b>x</b><i>y</i><u>z</u></div>',
    ),
    true,
  );
  assert.equal(
    looksLikeHtml('# Title\n\nSome **markdown** body with [a link](https://x.com).'),
    false,
  );
  assert.equal(looksLikeHtml('Plain text, no tags at all.'), false);
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

test('parseWebFetch treats Title:/URL: lines as metadata only in the preamble', () => {
  const page = parseWebFetch(
    [
      'Title: Sentry for Electron',
      'URL: https://docs.sentry.io/platforms/javascript/guides/electron/',
      '',
      'Learn how to set up Sentry.',
      '',
      'See the advanced guide for more.',
      '',
      'Title: Advanced configuration',
      'URL: https://docs.sentry.io/advanced/',
      '',
      'More detail here.',
    ].join('\n'),
  );
  assert.equal(page.title, 'Sentry for Electron');
  assert.equal(page.url, 'https://docs.sentry.io/platforms/javascript/guides/electron/');
  // Body lines that later begin with Title:/URL: are content, not metadata —
  // they must survive in the preview.
  assert.ok(page.body.includes('Title: Advanced configuration'));
  assert.ok(page.body.includes('URL: https://docs.sentry.io/advanced/'));
});

test('parseWebFetch strips a first-line fallback title so it does not repeat in the body', () => {
  const page = parseWebFetch(
    'Electron Auto-Update Guide\n\nShip updates safely with differential releases.\n\nMore detail here.',
  );
  assert.equal(page.title, 'Electron Auto-Update Guide');
  assert.equal(page.body, 'Ship updates safely with differential releases.\n\nMore detail here.');
});

test('parseWebFetch strips a fallback title while keeping a preamble URL line', () => {
  const page = parseWebFetch('My Guide\nURL: https://example.com/guide\n\nBody text.');
  assert.equal(page.title, 'My Guide');
  assert.equal(page.url, 'https://example.com/guide');
  assert.equal(page.body, 'Body text.');
});

test('parseWebFetch leaves an empty body when the whole page is the fallback title', () => {
  // A one-line fetch means the line is the title; restoring it as the body
  // would render the same text twice in the card.
  const page = parseWebFetch('Just A Title');
  assert.equal(page.title, 'Just A Title');
  assert.equal(page.body, '');
  const withUrl = parseWebFetch('Just A Title\nURL: https://example.com');
  assert.equal(withUrl.title, 'Just A Title');
  assert.equal(withUrl.url, 'https://example.com');
  assert.equal(withUrl.body, '');
});

test('parseWebFetch leaves an empty body when the whole page is an h1 title', () => {
  // The h1 becomes the card title; restoring the stripped text as the body
  // would render the same heading twice.
  const page = parseWebFetch('# Just A Heading');
  assert.equal(page.title, 'Just A Heading');
  assert.equal(page.body, '');
});

test('parseWebFetch leaves an empty body when the page is only Title/URL metadata', () => {
  // Both lines are card chrome (title + source row), never body content.
  const page = parseWebFetch('Title: Some Page\nURL: https://example.com');
  assert.equal(page.title, 'Some Page');
  assert.equal(page.url, 'https://example.com');
  assert.equal(page.body, '');
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

test('latestTodoSnapshot returns the newest real TodoWrite list', () => {
  const snapshot = latestTodoSnapshot([
    todoCall('a', { todos: '1. [pending] old' }),
    todoCall('b', { todos: '1. [completed] done\n2. [in_progress] now' }),
  ]);
  assert.equal(snapshot.foundPayload, true);
  assert.deepEqual(snapshot.todos, [
    { status: 'completed', text: 'done' },
    { status: 'in_progress', text: 'now' },
  ]);
});

test('latestTodoSnapshot honors an emptied list and skips partial calls', () => {
  const emptied = latestTodoSnapshot([
    todoCall('a', { todos: '1. [pending] old' }),
    todoCall('b', { todos: '' }),
  ]);
  assert.deepEqual(emptied, { todos: [], foundPayload: true });

  const partial = latestTodoSnapshot([
    todoCall('a', { todos: '1. [pending] old' }),
    todoCall('b', {}),
  ]);
  assert.deepEqual(partial.todos, [{ status: 'pending', text: 'old' }]);

  assert.deepEqual(latestTodoSnapshot([]), { todos: [], foundPayload: false });
});

test('activeTodoIndex prefers the running step, then the next pending one', () => {
  const steps: TodoItem[] = [
    { status: 'completed', text: 'a' },
    { status: 'in_progress', text: 'b' },
    { status: 'pending', text: 'c' },
  ];
  assert.equal(activeTodoIndex(steps), 1);
  assert.equal(activeTodoIndex([steps[0], steps[2]]), 1);
  assert.equal(activeTodoIndex([steps[0]]), 0);
  assert.equal(activeTodoIndex([]), -1);
});

test('only a real spawn is labeled a child session', () => {
  // A spawn: the label the model chose travels through untouched.
  assert.equal(
    CAT_LABEL[toolMeta('Task', { subagent_type: 'my-custom-droid' }).cat],
    'Child session',
  );
  assert.ok(isChildSessionTool('Task', { subagent_type: 'my-custom-droid' }));

  // Inspecting or stopping an existing subagent is not a spawn, so it must not
  // read as "Child session <tool>" in the feed.
  for (const name of ['TaskOutput', 'TaskStop']) {
    assert.equal(toolMeta(name, { task_id: 'abc' }).cat, 'subagent');
    assert.equal(CAT_LABEL[toolMeta(name, { task_id: 'abc' }).cat], 'Subagent');
    assert.ok(!isChildSessionTool(name, { task_id: 'abc' }));
  }
});
