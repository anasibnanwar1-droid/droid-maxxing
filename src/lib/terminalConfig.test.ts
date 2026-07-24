import test from 'node:test';
import assert from 'node:assert';
import {
  MAX_GLOBAL_TERMINALS,
  MAX_REPLAY_BYTES,
  MAX_TERMINALS_PER_MISSION,
  TERMINAL_LIMITS,
  buildPtyEnv,
  defaultShell,
  makeIdGenerator,
  resolveDimension,
  selectForReplay,
  validateCwd,
} from './terminalConfig';
import type { FsPromisesLike } from './terminalConfig';

interface MockFsOptions {
  real?: string;
  statThrows?: Error;
  realpathThrows?: Error;
  isDir?: boolean;
}

function mockFs(opts: MockFsOptions = {}): FsPromisesLike {
  return {
    stat: async () => {
      if (opts.statThrows) throw opts.statThrows;
      return { isDirectory: () => opts.isDir ?? true };
    },
    realpath: async () => {
      if (opts.realpathThrows) throw opts.realpathThrows;
      return opts.real ?? '/resolved';
    },
  };
}

test('defaultShell prefers $SHELL on POSIX with a login flag', () => {
  assert.deepEqual(defaultShell('darwin', { SHELL: '/bin/fish' }), {
    file: '/bin/fish',
    args: ['-l'],
  });
  assert.deepEqual(defaultShell('linux', {}), { file: '/bin/bash', args: ['-l'] });
  assert.deepEqual(defaultShell('darwin', {}), { file: '/bin/zsh', args: ['-l'] });
});

test('defaultShell uses cmd.exe on Windows unless SHELL points at pwsh', () => {
  assert.deepEqual(defaultShell('win32', { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }), {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: [],
  });
  assert.deepEqual(defaultShell('win32', { SHELL: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }), {
    file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    args: ['-NoLogo'],
  });
  // Fall back to cmd.exe when neither COMSPEC nor SHELL is set.
  assert.deepEqual(defaultShell('win32', {}), { file: 'cmd.exe', args: [] });
});

test('buildPtyEnv sets TERM and COLORTERM while preserving other vars', () => {
  const env = buildPtyEnv('darwin', { PATH: '/usr/bin', TERM: 'dumb' });
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.PATH, '/usr/bin');
});

test('validateCwd rejects empty / non-string input', async () => {
  assert.deepEqual(await validateCwd('', mockFs()), { ok: false, error: 'cwd is required' });
  assert.deepEqual(await validateCwd(undefined, mockFs()), { ok: false, error: 'cwd is required' });
  assert.deepEqual(await validateCwd(42, mockFs()), { ok: false, error: 'cwd is required' });
});

test('validateCwd surfaces stat failure as "does not exist"', async () => {
  const r = await validateCwd('/nope', mockFs({ statThrows: new Error('ENOENT') }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /does not exist/);
});

test('validateCwd rejects a path that is not a directory', async () => {
  const r = await validateCwd('/a-file', mockFs({ isDir: false }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not a directory/);
});

test('validateCwd returns the realpath on success', async () => {
  const r = await validateCwd('/tmp/foo', mockFs({ real: '/private/tmp/foo' }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.cwd, '/private/tmp/foo');
});

test('validateCwd surfaces realpath failure', async () => {
  const r = await validateCwd('/weird', mockFs({ realpathThrows: new Error('EIO') }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /realpath failed/);
});

test('selectForReplay returns everything under the cap', () => {
  const r = selectForReplay('abc', 10);
  assert.equal(r.data, 'abc');
  assert.equal(r.truncated, false);
  assert.equal(r.droppedBytes, 0);
});

test('selectForReplay trims oldest bytes and reports truncation', () => {
  const big = Buffer.alloc(10, 65).toString('utf8'); // 'AAAAAAAAAA'
  const r = selectForReplay(big, 4);
  assert.equal(r.data, 'AAAA');
  assert.equal(r.truncated, true);
  assert.equal(r.droppedBytes, 6);
});

test('selectForReplay accepts a zero cap', () => {
  const r = selectForReplay('hello', 0);
  assert.equal(r.data, '');
  assert.equal(r.truncated, true);
  assert.equal(r.droppedBytes, 5);
});

test('selectForReplay accepts a Uint8Array', () => {
  const bytes = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45]); // 'ABCDE'
  const r = selectForReplay(bytes, 3);
  assert.equal(r.data, 'CDE');
  assert.equal(r.truncated, true);
  assert.equal(r.droppedBytes, 2);
});

test('resolveDimension falls back for missing / non-finite / non-positive values', () => {
  assert.equal(resolveDimension(undefined, 80), 80);
  assert.equal(resolveDimension(null, 24), 24);
  assert.equal(resolveDimension('not-a-number', 80), 80);
  assert.equal(resolveDimension(NaN, 80), 80);
  assert.equal(resolveDimension(0, 80), 80);
  assert.equal(resolveDimension(-5, 80), 80);
  assert.equal(resolveDimension(132.7, 80), 132);
  assert.equal(resolveDimension('100', 80), 100);
});

test('makeIdGenerator returns the underlying generator on each call', () => {
  let n = 0;
  const gen = makeIdGenerator(() => `id-${++n}`);
  assert.equal(gen(), 'id-1');
  assert.equal(gen(), 'id-2');
});

test('terminal limits match the spec', () => {
  assert.equal(MAX_TERMINALS_PER_MISSION, 4);
  assert.equal(MAX_GLOBAL_TERMINALS, 8);
  assert.equal(MAX_REPLAY_BYTES, 2 * 1024 * 1024);
  assert.deepEqual(TERMINAL_LIMITS, {
    maxPerMission: 4,
    maxGlobal: 8,
    maxReplayBytes: 2 * 1024 * 1024,
  });
});
