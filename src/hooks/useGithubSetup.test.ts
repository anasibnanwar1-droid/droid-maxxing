import assert from 'node:assert/strict';
import test from 'node:test';

import type { GithubAvailability } from '../types/vcs.js';

type SetupModule = typeof import('./useGithubSetup.js');

async function loadSetupModule(): Promise<SetupModule> {
  const module = await import('./useGithubSetup.js').catch(() => null);
  assert.ok(module, 'useGithubSetup module must exist');
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

test('repository reset clears setup state under a new request identity', async () => {
  const { githubSetupReducer, initialGithubSetupState } = await loadSetupModule();
  const populated = {
    ...initialGithubSetupState,
    requestId: 4,
    availability: manualMissing,
    error: 'failed',
    manualGuideOpened: true,
  };

  const reset = githubSetupReducer(populated, { type: 'reset', requestId: 5 });

  assert.deepEqual(reset, { ...initialGithubSetupState, requestId: 5 });
});

test('stale probe and action results cannot update the current repository', async () => {
  const { githubSetupReducer, initialGithubSetupState } = await loadSetupModule();
  const current = { ...initialGithubSetupState, requestId: 8 };

  assert.equal(
    githubSetupReducer(current, {
      type: 'probe-finished',
      requestId: 7,
      availability: ready,
    }),
    current,
  );
  assert.equal(
    githubSetupReducer(current, {
      type: 'action-failed',
      requestId: 7,
      message: 'stale failure',
    }),
    current,
  );
});

test('current probe and action events produce explicit setup states', async () => {
  const { githubSetupReducer, initialGithubSetupState } = await loadSetupModule();
  const probing = githubSetupReducer(initialGithubSetupState, {
    type: 'probe-started',
    requestId: 1,
  });
  const missing = githubSetupReducer(probing, {
    type: 'probe-finished',
    requestId: 1,
    availability: homebrewMissing,
  });
  const installing = githubSetupReducer(missing, {
    type: 'action-started',
    requestId: 2,
    action: 'installing',
  });
  const failed = githubSetupReducer(installing, {
    type: 'action-failed',
    requestId: 2,
    message: 'Homebrew failed.',
  });

  assert.equal(missing.availability, homebrewMissing);
  assert.equal(installing.action, 'installing');
  assert.equal(installing.error, null);
  assert.equal(failed.action, 'idle');
  assert.equal(failed.error, 'Homebrew failed.');
});

test('primary action matches the next user-visible operation', async () => {
  const { primaryActionFor, initialGithubSetupState } = await loadSetupModule();

  assert.equal(primaryActionFor(initialGithubSetupState), 'none');
  assert.equal(
    primaryActionFor({ ...initialGithubSetupState, availability: homebrewMissing }),
    'install',
  );
  assert.equal(
    primaryActionFor({ ...initialGithubSetupState, availability: manualMissing }),
    'install',
  );
  assert.equal(
    primaryActionFor({
      ...initialGithubSetupState,
      availability: manualMissing,
      manualGuideOpened: true,
    }),
    'check',
  );
  assert.equal(
    primaryActionFor({ ...initialGithubSetupState, availability: signedOut }),
    'authenticate',
  );
  assert.equal(primaryActionFor({ ...initialGithubSetupState, availability: ready }), 'none');
  assert.equal(
    primaryActionFor({
      ...initialGithubSetupState,
      availability: homebrewMissing,
      action: 'installing',
    }),
    'none',
  );
});

test('manual install guide rechecks only when the app becomes visible', async () => {
  const { shouldRefreshGithubOnVisibility, initialGithubSetupState } = await loadSetupModule();
  const guideOpen = {
    ...initialGithubSetupState,
    availability: manualMissing,
    manualGuideOpened: true,
  };

  assert.equal(shouldRefreshGithubOnVisibility(guideOpen, false), true);
  assert.equal(shouldRefreshGithubOnVisibility(guideOpen, true), false);
  assert.equal(
    shouldRefreshGithubOnVisibility({ ...guideOpen, manualGuideOpened: false }, false),
    false,
  );
});
