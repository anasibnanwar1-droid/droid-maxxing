import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { GithubAvailability } from '../../types/vcs.js';

type CardModule = typeof import('./GithubSetupCard.js');

async function loadCard(): Promise<CardModule> {
  const module = await import('./GithubSetupCard.js').catch(() => null);
  assert.ok(module, 'GithubSetupCard module must exist');
  return module;
}

const homebrewMissing: GithubAvailability = {
  installed: false,
  authenticated: false,
  installMethod: 'homebrew',
};
const manualMissing: GithubAvailability = {
  installed: false,
  authenticated: false,
  installMethod: 'manual',
};
const signedOut: GithubAvailability = {
  installed: true,
  authenticated: false,
  installMethod: null,
};
const ready: GithubAvailability = {
  installed: true,
  authenticated: true,
  installMethod: null,
};

async function render(
  availability: GithubAvailability | null,
  overrides: Partial<{
    action: 'idle' | 'installing' | 'authenticating';
    error: string | null;
    manualGuideOpened: boolean;
  }> = {},
): Promise<string> {
  const { GithubSetupCard } = await loadCard();
  return renderToStaticMarkup(
    createElement(GithubSetupCard, {
      availability,
      action: overrides.action ?? 'idle',
      error: overrides.error ?? null,
      manualGuideOpened: overrides.manualGuideOpened ?? false,
      onPrimaryAction: () => undefined,
    }),
  );
}

test('checking and ready states do not render a recovery card', async () => {
  assert.equal(await render(null), '');
  assert.equal(await render(ready), '');
});

test('missing CLI offers Homebrew installation in Context', async () => {
  const html = await render(homebrewMissing);

  assert.match(html, /GitHub CLI required/);
  assert.match(html, /Install GitHub CLI/);
  assert.match(html, /pull requests, checks, and comments/i);
});

test('manual installation changes the same action into a verification button', async () => {
  const install = await render(manualMissing);
  const check = await render(manualMissing, { manualGuideOpened: true });

  assert.match(install, /Install GitHub CLI/);
  assert.match(install, /official installation page/i);
  assert.match(check, /Check installation/);
});

test('installed signed-out CLI offers GitHub browser authentication', async () => {
  const html = await render(signedOut);

  assert.match(html, /Connect GitHub/);
  assert.match(html, /Sign in to GitHub/);
});

test('busy setup states are disabled and explicit', async () => {
  const installing = await render(homebrewMissing, { action: 'installing' });
  const authenticating = await render(signedOut, { action: 'authenticating' });

  assert.match(installing, /Installing…/);
  assert.match(installing, /disabled=""/);
  assert.match(authenticating, /Waiting for GitHub…/);
  assert.match(authenticating, /disabled=""/);
});

test('setup failures use accessible live text in addition to color', async () => {
  const html = await render(homebrewMissing, { error: 'Homebrew could not install GitHub CLI.' });

  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Homebrew could not install GitHub CLI/);
});
