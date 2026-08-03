import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInstallCommand,
  buildUpdateCommand,
  completedProcessExitCode,
  pickInstallChannel,
  streamingInvocation,
} from './CliInstaller.js';

test('pickInstallChannel prefers script, then brew, then npm', () => {
  assert.equal(pickInstallChannel({ availableChannels: ['script', 'brew', 'npm'] }), 'script');
  assert.equal(pickInstallChannel({ availableChannels: ['brew', 'npm'] }), 'brew');
  assert.equal(pickInstallChannel({ availableChannels: ['npm'] }), 'npm');
  assert.equal(pickInstallChannel({ availableChannels: [] }), null);
});

test('buildInstallCommand maps each channel to its command', () => {
  const script = buildInstallCommand('script');
  assert.equal(script.command, 'sh');
  assert.equal(script.args[0], '-c');
  assert.match(script.args[1] ?? '', /curl -fsSL https:\/\/app\.factory\.ai\/cli/);
  assert.match(script.args[1] ?? '', /&& sh/);
  assert.deepEqual(buildInstallCommand('brew'), {
    command: 'brew',
    args: ['install', '--cask', 'droid'],
  });
  assert.deepEqual(buildInstallCommand('npm'), {
    command: 'npm',
    args: ['install', '-g', '@factory/cli'],
  });
});

test('the script install aborts when the download fails', () => {
  // `&&` chaining means `sh` only runs after a successful curl, so a failed
  // download cannot be reported as a successful install.
  assert.match(buildInstallCommand('script').args[1] ?? '', /curl[^&]*&&[^&]*sh/);
});

test('streamingInvocation never enables a generic shell', () => {
  assert.deepEqual(streamingInvocation({ command: '/usr/bin/droid', args: ['update'] }, 'darwin'), {
    command: '/usr/bin/droid',
    args: ['update'],
  });
  assert.deepEqual(
    streamingInvocation(
      { command: 'C:\\npm\\droid.cmd', args: ['update'] },
      'win32',
      'C:\\Windows\\System32\\cmd.exe',
    ),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\npm\\droid.cmd', 'update'],
    },
  );
  assert.deepEqual(streamingInvocation({ command: 'npm', args: ['install', '-g'] }, 'win32'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm', 'install', '-g'],
  });
});

test('signal termination is never reported as installer success', () => {
  assert.equal(completedProcessExitCode(null), 1);
  assert.equal(completedProcessExitCode(0), 0);
  assert.equal(completedProcessExitCode(9), 9);
});

test('buildUpdateCommand uses droid update when the CLI exists', () => {
  assert.deepEqual(buildUpdateCommand('npm', '/usr/bin/droid', true), {
    command: '/usr/bin/droid',
    args: ['update'],
  });
});

test('buildUpdateCommand falls back to install when the CLI is missing', () => {
  assert.deepEqual(buildUpdateCommand('brew', 'droid', false), {
    command: 'brew',
    args: ['install', '--cask', 'droid'],
  });
  assert.equal(buildUpdateCommand('npm', 'droid', false).command, 'npm');
});
