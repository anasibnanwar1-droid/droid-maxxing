import assert from 'node:assert/strict';
import test from 'node:test';

import * as github from './github.js';
import type { GithubAvailability, GithubSetupResult } from '../types/vcs.js';

interface SetupExports {
  getGithubAvailability?: () => Promise<GithubAvailability>;
  installGithubCli?: () => Promise<GithubSetupResult>;
  authenticateGithubCli?: () => Promise<GithubSetupResult>;
}

const setup = github as SetupExports;

function requireSetupFunctions() {
  assert.equal(typeof setup.getGithubAvailability, 'function');
  assert.equal(typeof setup.installGithubCli, 'function');
  assert.equal(typeof setup.authenticateGithubCli, 'function');
  return {
    getAvailability: setup.getGithubAvailability,
    install: setup.installGithubCli,
    authenticate: setup.authenticateGithubCli,
  };
}

function setDesktopApi(api: Record<string, () => Promise<unknown>>) {
  Object.defineProperty(globalThis, 'window', {
    value: { droidControl: api },
    configurable: true,
    writable: true,
  });
}

test.afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

test('GitHub setup wrappers preserve closed desktop results', async () => {
  const expectedAvailability: GithubAvailability = {
    installed: false,
    authenticated: false,
    installMethod: 'homebrew',
  };
  setDesktopApi({
    githubAvailable: async () => expectedAvailability,
    githubInstall: async () => ({ ok: true }),
    githubAuthenticate: async () => ({ ok: true }),
  });
  const functions = requireSetupFunctions();

  assert.deepEqual(await functions.getAvailability!(), expectedAvailability);
  assert.deepEqual(await functions.install!(), { ok: true });
  assert.deepEqual(await functions.authenticate!(), { ok: true });
});

test('GitHub setup wrappers return fixed transport failures', async () => {
  setDesktopApi({
    githubAvailable: async () => {
      throw new Error('private availability details');
    },
    githubInstall: async () => {
      throw new Error('private install details');
    },
    githubAuthenticate: async () => {
      throw new Error('private auth details');
    },
  });
  const functions = requireSetupFunctions();

  assert.deepEqual(await functions.getAvailability!(), {
    installed: false,
    authenticated: false,
    installMethod: 'manual',
  });
  assert.deepEqual(await functions.install!(), {
    ok: false,
    reason: 'install_failed',
    message: 'DROIDEX could not start GitHub CLI installation.',
  });
  assert.deepEqual(await functions.authenticate!(), {
    ok: false,
    reason: 'auth_failed',
    message: 'DROIDEX could not start GitHub sign-in.',
  });
});

test('GitHub setup operations explain when desktop integration is unavailable', async () => {
  Object.defineProperty(globalThis, 'window', {
    value: {},
    configurable: true,
    writable: true,
  });
  const functions = requireSetupFunctions();
  const expected: GithubSetupResult = {
    ok: false,
    reason: 'not_desktop',
    message: 'GitHub setup is available in the desktop app.',
  };

  assert.deepEqual(await functions.install!(), expected);
  assert.deepEqual(await functions.authenticate!(), expected);
});
