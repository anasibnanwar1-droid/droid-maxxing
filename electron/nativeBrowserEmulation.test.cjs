const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { runWithWebContentsDebugger } = require('./nativeBrowserEmulation.cjs');

function createContents() {
  const calls = [];
  let attached = false;
  return {
    calls,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach(version) {
        attached = true;
        calls.push(['attach', version]);
      },
      async sendCommand(method, params) {
        calls.push(['sendCommand', method, params]);
        return {};
      },
    },
  };
}

test('native browser avoids Chromium device emulation APIs', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const debuggerSource = fs.readFileSync(
    path.join(__dirname, 'nativeBrowserEmulation.cjs'),
    'utf8',
  );
  const source = `${mainSource}\n${debuggerSource}`;

  assert.doesNotMatch(source, /enableDeviceEmulation/);
  assert.doesNotMatch(source, /Emulation\.setDeviceMetricsOverride/);
});

test('debugger operations are serialized and reuse one attachment', async () => {
  const contents = createContents();
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });

  const first = runWithWebContentsDebugger(contents, async () => {
    contents.calls.push(['first-start']);
    markFirstStarted();
    await firstBlocked;
    contents.calls.push(['first-end']);
  });
  const second = runWithWebContentsDebugger(contents, async () => {
    contents.calls.push(['second']);
  });

  await firstStarted;
  assert.deepEqual(contents.calls, [['attach', '1.3'], ['first-start']]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(contents.calls, [['attach', '1.3'], ['first-start'], ['first-end'], ['second']]);
});

test('destroyed web contents skip debugger operations', async () => {
  let invoked = false;
  const result = await runWithWebContentsDebugger(
    {
      isDestroyed: () => true,
      debugger: null,
    },
    () => {
      invoked = true;
    },
  );

  assert.equal(result, undefined);
  assert.equal(invoked, false);
});
