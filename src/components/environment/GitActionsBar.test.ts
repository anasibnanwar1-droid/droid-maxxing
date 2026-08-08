import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { GitActionsBar } from './GitActionsBar.js';
import type { GitEnvironment } from '../../types/vcs.js';

const env: GitEnvironment = {
  isRepo: true,
  isGitHub: true,
  branch: 'feature/setup-card',
  detached: false,
  ahead: 0,
};

function render(githubReady: boolean): string {
  return renderToStaticMarkup(
    createElement(GitActionsBar, {
      cwd: '/repo',
      env,
      branches: null,
      isGitHub: true,
      githubReady,
      hasPr: false,
      onChanged: () => undefined,
    }),
  );
}

test('local git actions remain while Open PR waits for GitHub setup', () => {
  const html = render(false);

  assert.match(html, />Commit</);
  assert.match(html, />Push</);
  assert.doesNotMatch(html, />Open PR</);
});

test('Open PR returns when GitHub setup is ready', () => {
  assert.match(render(true), />Open PR</);
});
