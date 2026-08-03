const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const READY_PATTERN = /(?:^|\n)SIDECAR_READY (\d+)(?:\n|$)/;
const DEFAULT_READY_TIMEOUT_MS = 15_000;

function createSidecarSupervisor(options) {
  const spawnProcess = options.spawnProcess || spawn;
  const output = options.stdout || process.stdout;
  const errorOutput = options.stderr || process.stderr;
  const readyTimeoutMs = options.readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS;
  let child = null;
  let bridgeInfo = null;
  let pendingStart = null;

  function start() {
    if (child && child.exitCode === null && child.signalCode === null && bridgeInfo) {
      return Promise.resolve(bridgeInfo);
    }
    if (pendingStart) return pendingStart;

    const token = crypto.randomBytes(32).toString('hex');
    const nextChild = spawnProcess(process.execPath, [options.entryPath()], {
      cwd: options.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BRIDGE_PORT: process.env.BRIDGE_PORT || '0',
        BRIDGE_TOKEN: token,
        BRIDGE_EXIT_ON_STDIN_CLOSE: '1',
        BRIDGE_ALLOW_LOCAL_NO_TOKEN: options.isPackaged() ? '0' : '1',
      },
    });
    child = nextChild;

    pendingStart = new Promise((resolve, reject) => {
      let stdoutBuffer = '';
      let stderrBuffer = '';
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
        bridgeInfo = null;
        reject(error);
      }

      nextChild.once('error', fail);
      nextChild.once('exit', (code, signal) => {
        if (child === nextChild) {
          child = null;
          bridgeInfo = null;
        }
        if (!settled) {
          const detail = stderrBuffer.trim();
          fail(
            new Error(
              `Sidecar exited before ready (${code ?? signal ?? 'unknown'}).${detail ? ` ${detail}` : ''}`,
            ),
          );
        } else if (code || signal) {
          errorOutput.write(`sidecar exited: ${code ?? signal}\n`);
        }
      });
      nextChild.stdout.on('data', (chunk) => {
        const text = String(chunk);
        output.write(text);
        if (settled) return;
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
        stderrBuffer = `${stderrBuffer}${text}`.slice(-4_096);
        errorOutput.write(text);
      });
    }).finally(() => {
      pendingStart = null;
    });

    return pendingStart;
  }

  function stop() {
    const current = child;
    child = null;
    bridgeInfo = null;
    if (!current || current.killed) return;
    current.stdin?.end();
    current.kill();
  }

  return { start, getBridgeInfo: start, stop };
}

module.exports = { createSidecarSupervisor };
