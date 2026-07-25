const debuggerOperations = new WeakMap();

function runWithWebContentsDebugger(contents, operation) {
  if (!contents || contents.isDestroyed()) return Promise.resolve(undefined);
  const previous = debuggerOperations.get(contents) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      if (contents.isDestroyed()) return undefined;
      const dbg = contents.debugger;
      if (!dbg) throw new Error('Chromium debugger is unavailable.');
      if (!dbg.isAttached()) dbg.attach('1.3');
      return operation(dbg);
    });
  const tracked = current.finally(() => {
    if (debuggerOperations.get(contents) === tracked) debuggerOperations.delete(contents);
  });
  debuggerOperations.set(contents, tracked);
  return tracked;
}

module.exports = { runWithWebContentsDebugger };
