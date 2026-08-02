import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentReport } from '../../types/bridge';
import { stepsForEnv, advancePastRemovedStep, STEP_ORDER } from './stepFlow';

function envReport(cliPresent: boolean): EnvironmentReport {
  return {
    platform: 'darwin',
    arch: 'arm64',
    node: { present: true, version: '22.0.0' },
    cli: { present: cliPresent, version: cliPresent ? '1.0.0' : undefined },
    packageManagers: { brew: true },
    auth: { loginPresent: false, apiKeyConfigured: false },
    availableChannels: ['script'],
  } as EnvironmentReport;
}

test('install step is included while the environment is unknown', () => {
  assert.deepEqual(stepsForEnv(null), [
    'welcome',
    'system',
    'install',
    'signin',
    'preferences',
    'done',
  ]);
});

test('install step disappears once the CLI is present', () => {
  assert.deepEqual(stepsForEnv(envReport(true)), [
    'welcome',
    'system',
    'signin',
    'preferences',
    'done',
  ]);
  assert.deepEqual(stepsForEnv(envReport(false)), [
    'welcome',
    'system',
    'install',
    'signin',
    'preferences',
    'done',
  ]);
});

test('advancePastRemovedStep moves forward in canonical order', () => {
  const steps = stepsForEnv(envReport(true));
  assert.equal(advancePastRemovedStep(steps, 'install'), 'signin');
  assert.equal(advancePastRemovedStep(steps, 'welcome'), 'welcome');
});

test('advancePastRemovedStep falls back to the last step when nothing ahead remains', () => {
  const steps = stepsForEnv(envReport(true));
  // A step at the very end of the canonical order can only fall back.
  assert.equal(advancePastRemovedStep(steps.slice(0, -1), 'done'), 'preferences');
});

test('every computed step is part of the canonical order', () => {
  for (const env of [null, envReport(true), envReport(false)]) {
    for (const step of stepsForEnv(env)) {
      assert.ok(STEP_ORDER.includes(step), `${step} is canonical`);
    }
  }
});
