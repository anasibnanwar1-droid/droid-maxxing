import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('sidecar fails closed when bridge authentication is not configured', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BRIDGE_PORT: '0',
      BRIDGE_TOKEN: '',
      BRIDGE_ALLOW_LOCAL_NO_TOKEN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /BRIDGE_TOKEN is required/);
});
