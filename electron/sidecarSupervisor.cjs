const SIDECAR_READY_LINE = /^SIDECAR_READY(?:\s|$)/;

function createSidecarSupervisor(options) {
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;
  const initialRestartDelayMs = options.initialRestartDelayMs ?? 250;
  const maxRestartDelayMs = options.maxRestartDelayMs ?? 8_000;
  const stableReadyMs = options.stableReadyMs ?? 30_000;
  const configuredFailureLimit = options.maxConsecutiveFailures ?? 5;
  const maxConsecutiveFailures =
    Number.isFinite(configuredFailureLimit) && configuredFailureLimit >= 1
      ? Math.floor(configuredFailureLimit)
      : 5;

  let child = null;
  let restartTimer = null;
  let stableTimer = null;
  let consecutiveFailures = 0;
  let stopped = true;
  let terminalFailure = false;
  let detachOutput = () => undefined;

  function start() {
    if (terminalFailure) {
      terminalFailure = false;
      consecutiveFailures = 0;
    }
    stopped = false;
    spawnIfNeeded();
  }

  function spawnIfNeeded() {
    if (stopped || child || restartTimer) return;

    let spawned;
    try {
      spawned = options.spawnProcess();
    } catch (error) {
      scheduleRestart({ error });
      return;
    }

    child = spawned;
    detachOutput = observeReadyOutput(spawned, options.writeOutput, () =>
      scheduleStableReady(spawned),
    );
    spawned.once('error', (error) => handleUnexpectedExit(spawned, { error }));
    spawned.once('exit', (code, signal) => handleUnexpectedExit(spawned, { code, signal }));
    scheduleStableReady(spawned);
  }

  function handleUnexpectedExit(exitedChild, details) {
    if (child !== exitedChild) return;
    child = null;
    detachOutput();
    detachOutput = () => undefined;
    clearStableTimer();
    if (stopped) return;
    scheduleRestart(details);
  }

  function scheduleRestart(details) {
    if (stopped || terminalFailure || child || restartTimer) return;
    consecutiveFailures += 1;
    const failureCount = consecutiveFailures;
    if (failureCount >= maxConsecutiveFailures) {
      terminalFailure = true;
      stopped = true;
      options.onTerminalFailure?.({ ...details, failureCount });
      return;
    }

    const delayMs = Math.min(maxRestartDelayMs, initialRestartDelayMs * 2 ** (failureCount - 1));
    restartTimer = schedule(() => {
      restartTimer = null;
      spawnIfNeeded();
    }, delayMs);
    restartTimer.unref?.();
    options.onUnexpectedExit?.({ ...details, delayMs, failureCount });
  }

  function scheduleStableReady(expectedChild) {
    clearStableTimer();
    stableTimer = schedule(() => {
      stableTimer = null;
      markReady(expectedChild);
    }, stableReadyMs);
    stableTimer.unref?.();
  }

  function markReady(expectedChild = child) {
    if (stopped || !expectedChild || child !== expectedChild) return;
    consecutiveFailures = 0;
    clearStableTimer();
  }

  function stop() {
    stopped = true;
    terminalFailure = false;
    consecutiveFailures = 0;
    clearRestartTimer();
    clearStableTimer();
    const ownedChild = child;
    child = null;
    detachOutput();
    detachOutput = () => undefined;
    if (!ownedChild || ownedChild.killed) return;
    try {
      ownedChild.kill();
    } catch (error) {
      options.onStopError?.(error);
    }
  }

  function clearRestartTimer() {
    if (!restartTimer) return;
    cancel(restartTimer);
    restartTimer = null;
  }

  function clearStableTimer() {
    if (!stableTimer) return;
    cancel(stableTimer);
    stableTimer = null;
  }

  return { start, stop };
}

function observeReadyOutput(child, writeOutput, onReady) {
  if (!child.stdout?.on) return () => undefined;
  let buffered = '';
  const onData = (chunk) => {
    try {
      writeOutput?.(chunk);
    } catch {
      // Logging must not affect process supervision.
    }
    buffered += String(chunk);
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (SIDECAR_READY_LINE.test(line)) onReady();
      newline = buffered.indexOf('\n');
    }
    if (buffered.length > 1_024) buffered = buffered.slice(-1_024);
  };
  child.stdout.on('data', onData);
  return () => child.stdout.off?.('data', onData);
}

module.exports = { createSidecarSupervisor };
