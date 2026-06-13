import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInstallCommand, buildUpdateCommand, pickInstallChannel } from './CliInstaller.js';

test('pickInstallChannel prefers script, then brew, then npm', () => {
  assert.equal(pickInstallChannel({ availableChannels: ['script', 'brew', 'npm'] }), 'script');
  assert.equal(pickInstallChannel({ availableChannels: ['brew', 'npm'] }), 'brew');
  assert.equal(pickInstallChannel({ availableChannels: ['npm'] }), 'npm');
  assert.equal(pickInstallChannel({ availableChannels: [] }), null);
});

test('buildInstallCommand maps each channel to its command', () => {
  assert.deepEqual(buildInstallCommand('script'), { command: 'curl -fsSL https://app.factory.ai/cli | sh', args: [], shell: true });
  assert.deepEqual(buildInstallCommand('brew'), { command: 'brew', args: ['install', '--cask', 'droid'] });
  assert.deepEqual(buildInstallCommand('npm'), { command: 'npm', args: ['install', '-g', '@factory/cli'] });
});

test('buildUpdateCommand uses droid update when the CLI exists', () => {
  assert.deepEqual(buildUpdateCommand('npm', '/usr/bin/droid', true), { command: '/usr/bin/droid', args: ['update'] });
});

test('buildUpdateCommand falls back to install when the CLI is missing', () => {
  assert.deepEqual(buildUpdateCommand('brew', 'droid', false), { command: 'brew', args: ['install', '--cask', 'droid'] });
  assert.deepEqual(buildUpdateCommand(undefined, 'droid', false), { command: 'curl -fsSL https://app.factory.ai/cli | sh', args: [], shell: true });
});
