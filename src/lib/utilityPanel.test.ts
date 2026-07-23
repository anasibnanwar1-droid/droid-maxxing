import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateUtilityTab,
  closeUtilityTab,
  openUtilityTool,
  persistUtilityPanels,
  sanitizeUtilityPanels,
  updateUtilityTab,
  utilityTerminalCwds,
} from './utilityPanel';

test('singleton tools activate their existing tab', () => {
  let id = 0;
  const createId = () => `tab-${++id}`;
  const opened = openUtilityTool(undefined, 'review', createId);
  const withBrowser = openUtilityTool(opened, 'browser', createId);
  const reopened = openUtilityTool(withBrowser, 'review', createId);

  assert.equal(reopened.tabs.length, 2);
  assert.equal(reopened.activeTabId, 'tab-1');
  assert.equal(reopened.open, true);
});

test('terminal tabs are independent and closing the active tab chooses its neighbor', () => {
  let id = 0;
  const createId = () => `tab-${++id}`;
  const first = openUtilityTool(undefined, 'terminal', createId);
  const second = openUtilityTool(first, 'terminal', createId);
  const closed = closeUtilityTab(second, 'tab-2');

  assert.deepEqual(
    closed.tabs.map((tab) => tab.label),
    ['Terminal'],
  );
  assert.equal(closed.activeTabId, 'tab-1');
  assert.equal(closed.open, true);
  assert.equal(closeUtilityTab(closed, 'tab-1').open, false);
});

test('activation rejects unknown tab ids', () => {
  const panel = openUtilityTool(undefined, 'files', () => 'files');
  assert.equal(activateUtilityTab(panel, 'missing'), panel);
});

test('persisted utility panels are bounded and sanitized', () => {
  assert.deepEqual(
    sanitizeUtilityPanels({
      mission: {
        open: true,
        activeTabId: 'duplicate-review',
        tabs: [
          { id: 'review', tool: 'review', label: 'Review' },
          { id: 'duplicate-review', tool: 'review', label: 'Duplicate' },
          { id: 'terminal', tool: 'terminal', label: '', terminalId: 'pty-1' },
          { id: '', tool: 'files' },
          { id: 'bad', tool: 'unknown' },
        ],
      },
    }),
    {
      mission: {
        open: true,
        activeTabId: 'review',
        tabs: [{ id: 'review', tool: 'review', label: 'Review' }],
      },
    },
  );
});

test('terminal tabs are never persisted across app restarts', () => {
  const terminal = openUtilityTool(undefined, 'terminal', () => 'terminal');
  assert.deepEqual(persistUtilityPanels({ mission: terminal }), {
    mission: { open: false, tabs: [], activeTabId: null },
  });
});

test('running terminal tabs pin their mission worktree', () => {
  let panel = openUtilityTool(undefined, 'terminal', () => 'terminal');
  panel = updateUtilityTab(panel, 'terminal', { terminalId: 'pty-1' });
  assert.deepEqual(utilityTerminalCwds({ mission: panel }, { mission: '/repo/worktree' }), [
    '/repo/worktree',
  ]);
});
