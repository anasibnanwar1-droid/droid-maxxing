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

test('git turn baseline IPC carries appSessionId', async () => {
  const { api, calls } = loadApi();

  await api.gitMarkTurnStart('/repo', 'app-1');

  assert.equal(calls[0].channel, 'git-mark-turn-start');
  assert.equal(calls[0].payload.dir, '/repo');
  assert.equal(calls[0].payload.appSessionId, 'app-1');
  assert.equal('sessionId' in calls[0].payload, false);
});

test('app icon IPC carries the selected mode', async () => {
  const { api, calls } = loadApi();

  await api.setAppIcon('dark');
  await api.setAppIcon('system');

  assert.equal(calls[0].channel, 'app-set-icon');
  assert.equal(calls[0].payload.mode, 'dark');
  assert.equal(calls[1].channel, 'app-set-icon');
  assert.equal(calls[1].payload.mode, 'system');
});
