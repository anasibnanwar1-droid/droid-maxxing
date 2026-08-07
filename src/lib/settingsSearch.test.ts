import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bestTabForQuery,
  searchSettings,
  SETTINGS_SEARCH_ENTRIES,
  tabMatchesQuery,
} from './settingsSearch';

test('tabMatchesQuery keeps tabs whose content keywords match', () => {
  assert.equal(tabMatchesQuery('Notifications', ''), true);
  assert.equal(tabMatchesQuery('Notifications', 'play sound'), true);
  assert.equal(tabMatchesQuery('Notifications', 'banner'), true);
  assert.equal(tabMatchesQuery('Appearance', 'play sound'), false);
  assert.equal(tabMatchesQuery('Appearance', 'theme'), true);
  assert.equal(tabMatchesQuery('General', 'general'), true);
  assert.equal(tabMatchesQuery('General', 'compaction'), true);
  assert.equal(tabMatchesQuery('Setup & updates', 'onboarding'), true);
  assert.equal(tabMatchesQuery('Configuration', 'autonomy'), true);
  assert.equal(tabMatchesQuery('Worktrees', 'git worktree'), true);
  assert.equal(tabMatchesQuery('Privacy & diagnostics', 'sentry'), true);
  assert.equal(tabMatchesQuery('Keyboard shortcuts', 'hotkeys'), true);
  assert.equal(tabMatchesQuery('MCP servers', 'mcp'), true);
});

test('searchSettings ranks play sound under Notifications', () => {
  const hits = searchSettings('play sound');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].tab, 'Notifications');
  assert.match(hits[0].label.toLowerCase(), /sound/);
});

test('searchSettings finds controls across shipped tabs', () => {
  assert.equal(searchSettings('translucent')[0]?.tab, 'Appearance');
  assert.equal(searchSettings('image paste')[0]?.tab, 'General');
  assert.equal(searchSettings('cli status')[0]?.tab, 'Setup & updates');
  assert.equal(searchSettings('default autonomy')[0]?.tab, 'Configuration');
  assert.equal(searchSettings('crash reports')[0]?.tab, 'Privacy & diagnostics');
  assert.equal(searchSettings('remove worktree')[0]?.tab, 'Worktrees');
});

test('bestTabForQuery jumps to the right screen for every major area', () => {
  assert.equal(bestTabForQuery('play sound'), 'Notifications');
  assert.equal(bestTabForQuery('translucent'), 'Appearance');
  assert.equal(bestTabForQuery('autonomy'), 'Configuration');
  assert.equal(bestTabForQuery('onboarding'), 'Setup & updates');
  assert.equal(bestTabForQuery('compaction'), 'General');
  assert.equal(bestTabForQuery('sentry'), 'Privacy & diagnostics');
  assert.equal(bestTabForQuery('hotkeys'), 'Keyboard shortcuts');
  assert.equal(bestTabForQuery('mcp'), 'MCP servers');
  assert.equal(bestTabForQuery('zzzz-no-match'), null);
  assert.equal(bestTabForQuery(''), null);
});

test('catalog covers every personal nav tab at least once', () => {
  const personalTabs = [
    'General',
    'Setup & updates',
    'Profile',
    'Appearance',
    'Notifications',
    'Configuration',
    'Personalization',
    'Keyboard shortcuts',
    'Usage & billing',
    'Privacy & diagnostics',
  ];
  const indexed = new Set(SETTINGS_SEARCH_ENTRIES.map((e) => e.tab));
  for (const tab of personalTabs) {
    assert.ok(indexed.has(tab), `missing index entries for ${tab}`);
  }
});
