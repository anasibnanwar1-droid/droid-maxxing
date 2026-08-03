import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldInstallAppUpdateAutomatically } from './appUpdate';

const baseUpdate = {
  current: '0.1.0',
  latest: '0.2.0',
  updateAvailable: true,
  arch: 'arm64',
  platform: 'darwin',
} as const;

test('signed builds may install an available update automatically', () => {
  assert.equal(
    shouldInstallAppUpdateAutomatically({ ...baseUpdate, installMode: 'automatic' }),
    true,
  );
});

test('unsigned builds only surface an available manual download', () => {
  assert.equal(
    shouldInstallAppUpdateAutomatically({ ...baseUpdate, installMode: 'manual' }),
    false,
  );
  assert.equal(
    shouldInstallAppUpdateAutomatically({
      ...baseUpdate,
      updateAvailable: false,
      installMode: 'automatic',
    }),
    false,
  );
});
