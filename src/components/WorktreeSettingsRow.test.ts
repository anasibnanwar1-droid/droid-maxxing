import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GitWorktree } from '../types/vcs.js';
import { WorktreeSettingsRow } from './WorktreeSettingsRow.js';

const WORKTREE: GitWorktree = {
  path: '/repo/.worktrees/feature',
  head: 'abc123',
  branch: 'feature',
  bare: false,
  detached: false,
  locked: false,
  isMain: false,
  isCurrent: false,
};

function renderRow({ isMerged = false } = {}): string {
  return renderToStaticMarkup(
    createElement(WorktreeSettingsRow, {
      worktree: WORKTREE,
      pullRequest: null,
      linkedSessions: [],
      activeAppSessionId: null,
      isMerged,
      isInUse: false,
      isExpanded: false,
      checking: null,
      removing: null,
      onRequestRemoval: () => undefined,
      onToggle: () => undefined,
      onOpenChat: () => undefined,
    }),
  );
}

test('merged worktrees use the GitHub merged icon without a text badge', () => {
  const html = renderRow({ isMerged: true });
  assert.match(html, /aria-label="Merged"/);
  assert.match(html, /fill-\[#a371f7\]/);
  assert.doesNotMatch(html, />merged</i);
});

test('worktree paths use the regular UI typeface', () => {
  const html = renderRow();
  assert.match(html, /\/repo\/\.worktrees\/feature/);
  assert.doesNotMatch(html, /font-mono/);
});
