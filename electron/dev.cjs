const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const electron = require('electron');
const startUrl = process.env.ELECTRON_START_URL || 'http://127.0.0.1:1420';
const viteTarget = new URL(startUrl);
const vite = spawn(
  npmCmd(),
  ['run', 'dev', '--', '--host', viteTarget.hostname, '--port', viteTarget.port || '1420'],
  {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  },
);

let electronProcess = null;

waitFor(`${startUrl}/@vite/client`)
  .then(() => {
    electronProcess = spawn(electron, [path.join(__dirname, 'main.cjs')], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_START_URL: startUrl },
    });
    electronProcess.on('exit', (code) => {
      stop(vite);
      process.exit(code ?? 0);
    });
  })
  .catch((err) => {
    console.error(err.message);
    stop(vite);
    process.exit(1);
  });

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

function shutdown(code) {
  stop(electronProcess);
  stop(vite);
  process.exit(code);
}

function stop(child) {
  if (child && !child.killed) child.kill();
}

function waitFor(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(poll, 250);
      });
    };
    poll();
  });
}

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}
