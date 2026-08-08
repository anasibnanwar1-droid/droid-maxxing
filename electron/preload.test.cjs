const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadApi(invokeResult) {
  const calls = [];
  let api;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ channel, payload });
      return Promise.resolve(invokeResult);
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

test('notification IPC returns the main-process delivery result unchanged', async () => {
  const expected = { shown: false, reason: 'failed', message: 'disabled' };
  const { api, calls } = loadApi(expected);

  assert.deepEqual(
    await api.notify('DROIDEX', 'Finished', { silent: true, appSessionId: 'app-1' }),
    expected,
  );
  assert.equal(calls[0].channel, 'notify');
  assert.equal(calls[0].payload.title, 'DROIDEX');
  assert.equal(calls[0].payload.body, 'Finished');
  assert.equal(calls[0].payload.silent, true);
  assert.equal(calls[0].payload.appSessionId, 'app-1');
});

test('native browser IPC carries browserSessionId', async () => {
  const { api, calls } = loadApi();

  await api.nativeBrowserOpen('browser-1', 'https://example.test');

  assert.equal(calls[0].channel, 'native-browser-open');
  assert.equal(calls[0].payload.browserSessionId, 'browser-1');
  assert.equal(calls[0].payload.url, 'https://example.test');
  assert.equal('sessionId' in calls[0].payload, false);
});

test('git turn baseline IPC carries its provisional owner', async () => {
  const { api, calls } = loadApi();

  await api.gitMarkTurnStart('/repo', 'client-1');

  assert.equal(calls[0].channel, 'git-mark-turn-start');
  assert.equal(calls[0].payload.dir, '/repo');
  assert.equal(calls[0].payload.ownerId, 'client-1');
});

test('git turn baseline adoption IPC correlates client and app session identities', async () => {
  const { api, calls } = loadApi();

  await api.gitAdoptTurnBaseline('/repo', 'client-1', 'app-1');

  assert.equal(calls[0].channel, 'git-adopt-turn-baseline');
  assert.equal(calls[0].payload.dir, '/repo');
  assert.equal(calls[0].payload.clientRef, 'client-1');
  assert.equal(calls[0].payload.appSessionId, 'app-1');
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

test('app update download does not accept a renderer-supplied URL', async () => {
  const { api, calls } = loadApi();

  await api.downloadAppUpdate();

  assert.equal(calls[0].channel, 'app-download-update');
  assert.equal(calls[0].payload, undefined);
});

test('automatic diagnostics preference uses closed IPC payloads', async () => {
  const { api, calls } = loadApi();

  await api.getAutomaticDiagnostics();
  await api.setAutomaticDiagnostics(false);

  assert.deepEqual(calls[0], { channel: 'diagnostics-preference-get', payload: undefined });
  assert.equal(calls[1].channel, 'diagnostics-preference-set');
  assert.equal(calls[1].payload.enabled, false);
});

test('GitHub setup IPC accepts no renderer-controlled command payload', async () => {
  const expected = { ok: true };
  const { api, calls } = loadApi(expected);

  assert.deepEqual(await api.githubInstall(), expected);
  assert.deepEqual(await api.githubAuthenticate(), expected);
  assert.deepEqual(calls[0], { channel: 'github-install', payload: undefined });
  assert.deepEqual(calls[1], { channel: 'github-authenticate', payload: undefined });
});
