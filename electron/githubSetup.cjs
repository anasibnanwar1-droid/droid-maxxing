// GitHub CLI installation and browser authentication for the Context panel.
// This module owns the single active setup process and never exposes command
// output or credentials outside Electron.
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT = 15000;
const MAX_BUFFER = 16 * 1024 * 1024;
const COMMON_BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
const INSTALL_TIMEOUT = 10 * 60 * 1000;
const AUTH_TIMEOUT = 10 * 60 * 1000;
const MAX_AUTH_OUTPUT = 16 * 1024;

let cachedBrewExecutablePromise;
let activeSetup = null;

function runFile(file, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        spawnFailed: !!err && err.code === 'ENOENT',
      });
    });
  });
}

async function resolveBrewExecutable(options = {}) {
  const env = options.env || process.env;
  const access =
    options.access || ((candidate) => fs.promises.access(candidate, fs.constants.X_OK));
  const execute = options.runFile || runFile;
  const pathCandidates = String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, 'brew'));
  const candidates = [...new Set([...pathCandidates, ...COMMON_BREW_PATHS])];

  const validate = async (candidate) => {
    try {
      await access(candidate);
      const version = await execute(candidate, ['--version'], { timeout: 5_000 });
      return version.code === 0 ? candidate : null;
    } catch {
      return null;
    }
  };

  for (const candidate of candidates) {
    const valid = await validate(candidate);
    if (valid) return valid;
  }

  const shell = String(env.SHELL || '').trim();
  if (!shell) return null;
  const lookup = await execute(shell, ['-lc', 'command -v brew'], { timeout: 5_000 });
  if (lookup.code !== 0) return null;
  const shellCandidate = lookup.stdout.trim().split(/\r?\n/, 1)[0];
  if (!path.isAbsolute(shellCandidate)) return null;
  return validate(shellCandidate);
}

async function cachedBrewExecutable() {
  cachedBrewExecutablePromise ||= resolveBrewExecutable();
  const executable = await cachedBrewExecutablePromise;
  if (!executable) cachedBrewExecutablePromise = undefined;
  return executable;
}

function runSetupFile(file, args, { timeout, operation }) {
  return new Promise((resolve) => {
    let child;
    let timer;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (operation.child === child) operation.child = null;
      child?.removeAllListeners();
      resolve(result);
    };

    try {
      child = spawn(file, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      finish({ code: 1, timedOut: false });
      return;
    }

    operation.child = child;
    child.once('error', () => finish({ code: 1, timedOut: false }));
    child.once('close', (code) =>
      finish({ code: typeof code === 'number' ? code : 1, timedOut: false }),
    );
    timer = setTimeout(() => {
      child.kill();
      finish({ code: 1, timedOut: true });
    }, timeout);
    timer.unref?.();
    if (operation.cancelled) child.kill();
  });
}

async function install(options = {}) {
  if (activeSetup) {
    return { ok: false, reason: 'busy', message: 'GitHub setup is already running.' };
  }

  const operation = { kind: 'install', cancelled: false, child: null };
  activeSetup = operation;
  const resolveBrew = options.resolveBrew || cachedBrewExecutable;
  const execute = options.execute || runSetupFile;
  const resolveGh = options.resolveGh || (async () => null);

  try {
    const brew = await resolveBrew();
    if (!brew) {
      return { ok: false, reason: 'installer_missing', message: 'Homebrew is not installed.' };
    }
    const result = await execute(brew, ['install', 'gh'], {
      timeout: INSTALL_TIMEOUT,
      operation,
    });
    if (operation.cancelled) {
      return { ok: false, reason: 'cancelled', message: 'GitHub CLI installation was cancelled.' };
    }
    if (result.timedOut) {
      return { ok: false, reason: 'timeout', message: 'GitHub CLI installation timed out.' };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        reason: 'install_failed',
        message: 'Homebrew could not install GitHub CLI.',
      };
    }
    options.invalidateGh?.();
    if (!(await resolveGh())) {
      return {
        ok: false,
        reason: 'verification_failed',
        message: 'GitHub CLI was not found after installation.',
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: 'install_failed',
      message: 'Homebrew could not install GitHub CLI.',
    };
  } finally {
    if (activeSetup === operation) activeSetup = null;
  }
}

function cancelSetup() {
  if (!activeSetup) return;
  activeSetup.cancelled = true;
  activeSetup.child?.kill();
}

function isGithubDeviceUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.pathname === '/login/device' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

async function verifyGithubAuth(executable, execute = runFile) {
  const result = await execute(executable, ['auth', 'status', '--hostname', 'github.com'], {
    timeout: DEFAULT_TIMEOUT,
  });
  return result.code === 0;
}

function runAuthenticationProcess(executable, openExternal, operation, options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  const verifyAuth = options.verifyAuth || (() => verifyGithubAuth(executable));
  const scheduleTimeout = options.setTimer || setTimeout;
  const cancelTimeout = options.clearTimer || clearTimeout;
  const timeoutMs = options.authTimeoutMs || AUTH_TIMEOUT;

  return new Promise((resolve) => {
    let child;
    let output = '';
    let browserPromise = null;
    let rejectedUrl = false;
    let timedOut = false;
    let settled = false;
    let timer;

    const cleanup = () => {
      if (timer) cancelTimeout(timer);
      child?.stdout?.removeListener('data', onOutput);
      child?.stderr?.removeListener('data', onOutput);
      child?.removeListener('error', onError);
      child?.removeListener('close', onClose);
      if (operation.child === child) operation.child = null;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const failBrowser = (message) => {
      child?.kill();
      finish({ ok: false, reason: 'browser_failed', message });
    };
    const inspectOutput = (text) => {
      if (settled || browserPromise || rejectedUrl) return;
      const match = text.match(/https?:\/\/[^\s"'<>]+/i);
      if (!match) return;
      const url = match[0];
      if (!isGithubDeviceUrl(url)) {
        rejectedUrl = true;
        failBrowser('GitHub CLI did not provide a trusted sign-in page.');
        return;
      }
      browserPromise = Promise.resolve()
        .then(() => openExternal(url))
        .catch(() => {
          failBrowser('DROIDEX could not open the GitHub sign-in page.');
          return false;
        });
    };
    const onOutput = (chunk) => {
      if (settled || browserPromise || rejectedUrl) return;
      output = `${output}${String(chunk)}`.slice(-MAX_AUTH_OUTPUT);
      const lastLineBreak = Math.max(output.lastIndexOf('\n'), output.lastIndexOf('\r'));
      if (lastLineBreak < 0) return;
      const complete = output.slice(0, lastLineBreak + 1);
      output = output.slice(lastLineBreak + 1);
      inspectOutput(complete);
    };
    const onError = () => {
      finish({ ok: false, reason: 'auth_failed', message: 'GitHub sign-in could not start.' });
    };
    const onClose = async (code) => {
      if (settled) return;
      if (!browserPromise && !rejectedUrl && output) inspectOutput(output);
      if (settled) return;
      if (operation.cancelled) {
        finish({ ok: false, reason: 'cancelled', message: 'GitHub sign-in was cancelled.' });
        return;
      }
      if (timedOut) {
        finish({ ok: false, reason: 'timeout', message: 'GitHub sign-in timed out.' });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, reason: 'auth_failed', message: 'GitHub sign-in did not finish.' });
        return;
      }
      if (!browserPromise) {
        finish({
          ok: false,
          reason: 'browser_failed',
          message: 'GitHub CLI did not provide a trusted sign-in page.',
        });
        return;
      }
      await browserPromise;
      if (settled) return;
      const authenticated = await verifyAuth();
      if (!authenticated) {
        finish({
          ok: false,
          reason: 'auth_failed',
          message: 'GitHub CLI could not verify the signed-in account.',
        });
        return;
      }
      finish({ ok: true });
    };

    try {
      child = spawnProcess(
        executable,
        [
          'auth',
          'login',
          '--hostname',
          'github.com',
          '--git-protocol',
          'https',
          '--web',
          '--clipboard',
          '--skip-ssh-key',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      finish({ ok: false, reason: 'auth_failed', message: 'GitHub sign-in could not start.' });
      return;
    }

    operation.child = child;
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', onError);
    child.once('close', onClose);
    timer = scheduleTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref?.();
    if (operation.cancelled) child.kill();
  });
}

async function authenticate(openExternal, options = {}) {
  if (activeSetup) {
    return { ok: false, reason: 'busy', message: 'GitHub setup is already running.' };
  }

  const operation = { kind: 'authenticate', cancelled: false, child: null };
  activeSetup = operation;
  const resolveGh = options.resolveGh || (async () => null);
  try {
    const executable = await resolveGh();
    if (operation.cancelled) {
      return { ok: false, reason: 'cancelled', message: 'GitHub sign-in was cancelled.' };
    }
    if (!executable) {
      return { ok: false, reason: 'auth_failed', message: 'GitHub CLI is not installed.' };
    }
    return await runAuthenticationProcess(executable, openExternal, operation, options);
  } finally {
    if (activeSetup === operation) activeSetup = null;
  }
}

module.exports = {
  authenticate,
  cancelSetup,
  install,
  isGithubDeviceUrl,
  resolveBrewExecutable,
};
