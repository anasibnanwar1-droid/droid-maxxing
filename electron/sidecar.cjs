const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const READY_PATTERN = /(?:^|\n)SIDECAR_READY (\d+)(?:\n|$)/;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 6_000;

function createSidecarSupervisor(options) {
  const spawnProcess = options.spawnProcess || spawn;
  const output = options.stdout || process.stdout;
  const errorOutput = options.stderr || process.stderr;
  const readyTimeoutMs = options.readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs || DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let child = null;
  let bridgeInfo = null;
  let pendingStart = null;
  let activeRun = null;

  function start() {
    if (child && child.exitCode === null && child.signalCode === null && bridgeInfo) {
      return Promise.resolve(bridgeInfo);
    }
    if (pendingStart) return pendingStart;

    const token = crypto.randomBytes(32).toString('hex');
    const assetToken = crypto.randomBytes(32).toString('hex');
    const nextChild = spawnProcess(process.execPath, [options.entryPath()], {
      cwd: options.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BRIDGE_PORT: process.env.BRIDGE_PORT || '0',
        BRIDGE_TOKEN: token,
        BROWSER_ASSET_TOKEN: assetToken,
        BRIDGE_EXIT_ON_STDIN_CLOSE: '1',
      },
    });
    const run = {
      child: nextChild,
      intentionalStop: false,
      cancelStartup: null,
      resolveExit: null,
    };
    run.exitPromise = new Promise((resolve) => {
      run.resolveExit = resolve;
    });
    child = nextChild;
    activeRun = run;

    const startPromise = new Promise((resolve, reject) => {
      let stdoutBuffer = '';
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${readyTimeoutMs}ms.`));
        nextChild.kill();
      }, readyTimeoutMs);
      timeout.unref?.();

      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (activeRun === run) bridgeInfo = null;
        reject(error);
      }
      run.cancelStartup = () => fail(new Error('Sidecar startup was cancelled.'));

      nextChild.once('error', fail);
      nextChild.once('exit', (code, signal) => {
        run.resolveExit?.();
        if (activeRun === run) {
          activeRun = null;
          child = null;
          bridgeInfo = null;
        }
        if (!settled) {
          fail(new Error(`Sidecar exited before ready (${code ?? signal ?? 'unknown'}).`));
        } else if (!run.intentionalStop && (code || signal)) {
          errorOutput.write(`sidecar exited: ${code ?? signal}\n`);
        }
      });
      nextChild.stdout.on('data', (chunk) => {
        const text = String(chunk);
        output.write(text);
        if (settled || activeRun !== run) return;
        stdoutBuffer = `${stdoutBuffer}${text}`.slice(-512);
        const match = stdoutBuffer.match(READY_PATTERN);
        if (!match) return;
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          fail(new Error(`Sidecar reported an invalid port: ${match[1]}.`));
          nextChild.kill();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        bridgeInfo = { port, token };
        resolve(bridgeInfo);
      });
      nextChild.stderr.on('data', (chunk) => {
        const text = String(chunk);
        errorOutput.write(text);
      });
    });
    const wrappedStart = startPromise.finally(() => {
      if (pendingStart === wrappedStart) pendingStart = null;
    });
    pendingStart = wrappedStart;

    return pendingStart;
  }

  function stop() {
    const current = child;
    const run = activeRun;
    if (run && run.child === current) {
      run.intentionalStop = true;
      run.cancelStartup?.();
      activeRun = null;
    }
    child = null;
    bridgeInfo = null;
    pendingStart = null;
    if (!current || current.killed) return Promise.resolve();
    current.stdin?.end();
    current.kill('SIGTERM');
    let timeout;
    const forcedExit = new Promise((resolve) => {
      timeout = setTimeout(() => {
        if (current.exitCode === null && current.signalCode === null) current.kill('SIGKILL');
        resolve();
      }, shutdownTimeoutMs);
      timeout.unref?.();
    });
    return Promise.race([run?.exitPromise ?? Promise.resolve(), forcedExit]).finally(() => {
      clearTimeout(timeout);
    });
  }

  return { start, getBridgeInfo: start, stop };
}

module.exports = { createSidecarSupervisor };
