import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSetupBlocker, scheduleEnvDetect, shouldShowOnboarding } from './useOnboarding';
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

test('scheduleEnvDetect runs immediately when not deferred', () => {
  let calls = 0;
  const cancel = scheduleEnvDetect(
    false,
    () => {
      calls += 1;
    },
    () => {
      throw new Error('idle scheduler must not be used when not deferring');
    },
  );
  assert.equal(calls, 1);
  cancel();
  assert.equal(calls, 1);
});

test('scheduleEnvDetect defers until the idle callback fires', () => {
  let calls = 0;
  let pending: (() => void) | undefined;
  scheduleEnvDetect(
    true,
    () => {
      calls += 1;
    },
    (callback) => {
      pending = callback;
      return () => {};
    },
  );
  assert.equal(calls, 0, 'no probe before idle');
  pending?.();
  assert.equal(calls, 1);
});

test('cancelling a deferred scheduleEnvDetect prevents the probe', () => {
  let calls = 0;
  let cancelled = false;
  const cancel = scheduleEnvDetect(
    true,
    () => {
      calls += 1;
    },
    () => () => {
      cancelled = true;
    },
  );
  cancel();
  assert.equal(cancelled, true);
  assert.equal(calls, 0);
});
