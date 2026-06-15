import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSetupBlocker, shouldShowOnboarding } from './useOnboarding';
import type { EnvironmentReport } from '../types/bridge';

function env(partial: Partial<EnvironmentReport>): EnvironmentReport {
  return {
    platform: 'darwin',
    arch: 'arm64',
    osVersion: '24.0.0',
    node: { present: true, version: '22.0.0' },
    cli: { present: true, path: '/usr/bin/droid', version: '0.144.2' },
    packageManagers: { brew: true, npm: true, curl: true, pnpm: false },
    auth: { apiKeyConfigured: false, loginPresent: true },
    availableChannels: ['script', 'brew', 'npm'],
    ...partial,
  };
}

test('shouldShowOnboarding only when not completed', () => {
  assert.equal(shouldShowOnboarding(null), false);
  assert.equal(shouldShowOnboarding({ completed: false }), true);
  assert.equal(shouldShowOnboarding({ completed: true }), false);
});

test('hasSetupBlocker flags a missing CLI', () => {
  assert.equal(hasSetupBlocker(env({ cli: { present: false, path: 'droid' } })), true);
});

test('hasSetupBlocker flags missing auth when no api key', () => {
  assert.equal(
    hasSetupBlocker(env({ auth: { apiKeyConfigured: false, loginPresent: false } })),
    true,
  );
});

test('no blocker when signed in or api key configured', () => {
  assert.equal(
    hasSetupBlocker(env({ auth: { apiKeyConfigured: false, loginPresent: true } })),
    false,
  );
  assert.equal(
    hasSetupBlocker(env({ auth: { apiKeyConfigured: true, loginPresent: false } })),
    false,
  );
  assert.equal(hasSetupBlocker(null), false);
});
