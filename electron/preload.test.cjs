const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadApi() {
  const calls = [];
  let api;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ channel, payload });
      return Promise.resolve();
    },
    on() {},
    removeListener() {},
  };
  const source = readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  vm.runInNewContext(source, {
    require(name) {
      if (name !== 'electron') throw new Error(`Unexpected preload dependency: ${name}`);
      return {
        contextBridge: {
          exposeInMainWorld(_name, exposed) {
            api = exposed;
          },
        },
        ipcRenderer,
      };
    },
  });
  return { api, calls };
}

test('native browser IPC carries browserSessionId', async () => {
  const { api, calls } = loadApi();

  await api.nativeBrowserOpen('browser-1', 'https://example.test');

  assert.equal(calls[0].channel, 'native-browser-open');
  assert.equal(calls[0].payload.browserSessionId, 'browser-1');
  assert.equal(calls[0].payload.url, 'https://example.test');
  assert.equal('sessionId' in calls[0].payload, false);
});

test('studio native browser IPC carries canvas content zoom', async () => {
  const { api, calls } = loadApi();
  const bounds = { x: 10, y: 20, width: 600, height: 400 };

  await api.nativeBrowserOpen('studio-1', 'http://localhost:5173', bounds, undefined, 0.5);
  await api.nativeBrowserAttach('studio-1', bounds, 'http://localhost:5173', 0.5);
  await api.nativeBrowserSetBounds('studio-1', bounds, 0.75);

  assert.equal(calls[0].channel, 'native-browser-open');
  assert.equal(calls[0].payload.browserSessionId, 'studio-1');
  assert.equal(calls[0].payload.bounds, bounds);
  assert.equal(calls[0].payload.contentZoom, 0.5);
  assert.equal(calls[1].channel, 'native-browser-attach');
  assert.equal(calls[1].payload.browserSessionId, 'studio-1');
  assert.equal(calls[1].payload.bounds, bounds);
  assert.equal(calls[1].payload.url, 'http://localhost:5173');
  assert.equal(calls[1].payload.contentZoom, 0.5);
  assert.equal(calls[2].channel, 'native-browser-set-bounds');
  assert.equal(calls[2].payload.browserSessionId, 'studio-1');
  assert.equal(calls[2].payload.bounds, bounds);
  assert.equal(calls[2].payload.contentZoom, 0.75);
});

test('git turn baseline IPC carries appSessionId', async () => {
  const { api, calls } = loadApi();

  await api.gitMarkTurnStart('/repo', 'app-1');

  assert.equal(calls[0].channel, 'git-mark-turn-start');
  assert.equal(calls[0].payload.dir, '/repo');
  assert.equal(calls[0].payload.appSessionId, 'app-1');
  assert.equal('sessionId' in calls[0].payload, false);
});
