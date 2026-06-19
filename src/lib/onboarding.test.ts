import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  checkAppUpdate,
  downloadAppUpdate,
  getAppVersion,
  getOnboarding,
  openExternal,
  relaunchApp,
  setOnboarding,
} from './onboarding';

type TestWindow = typeof globalThis & { window?: Window & typeof globalThis };

function clearWindow(): void {
  delete (globalThis as TestWindow).window;
}

function installWindow(windowPatch: Partial<Window & typeof globalThis>): void {
  (globalThis as TestWindow).window = windowPatch as Window & typeof globalThis;
}

afterEach(() => {
  clearWindow();
});

test('onboarding helpers return browser defaults outside desktop', async () => {
  clearWindow();

  assert.deepEqual(await getOnboarding(), { completed: true, version: 1 });
  assert.deepEqual(await setOnboarding({ defaultEditor: 'cursor' }), {
    completed: true,
    version: 1,
    defaultEditor: 'cursor',
  });
  assert.equal(await getAppVersion(), '0.0.0');
  assert.equal(await checkAppUpdate(), null);
  assert.equal(await downloadAppUpdate(), null);
  await relaunchApp();
});

test('onboarding helpers delegate to the desktop bridge', async () => {
  const opened: string[] = [];
  installWindow({
    droidControl: {
      getOnboarding: async () => ({ completed: false, version: 2 }),
      setOnboarding: async (patch) => ({ completed: true, version: 2, ...patch }),
      appVersion: async () => '1.2.3',
      checkAppUpdate: async () => ({
        current: '1.0.0',
        latest: '1.2.3',
        updateAvailable: true,
        arch: 'arm64',
        platform: 'darwin',
        dmgUrl: 'https://example.com/app.dmg',
        feedConfigured: true,
      }),
      downloadAppUpdate: async (dmgUrl) => ({ mode: 'download', path: dmgUrl }),
      relaunchApp: async () => {
        opened.push('relaunched');
      },
      openExternal: async (url) => {
        opened.push(url);
      },
    } as Window['droidControl'],
  });

  assert.deepEqual(await getOnboarding(), { completed: false, version: 2 });
  assert.deepEqual(await setOnboarding({ cliAutoUpdate: true }), {
    completed: true,
    version: 2,
    cliAutoUpdate: true,
  });
  assert.equal(await getAppVersion(), '1.2.3');
  assert.equal((await checkAppUpdate())?.latest, '1.2.3');
  assert.deepEqual(await downloadAppUpdate('https://example.com/app.dmg'), {
    mode: 'download',
    path: 'https://example.com/app.dmg',
  });
  await relaunchApp();
  await openExternal('https://example.com');
  assert.deepEqual(opened, ['relaunched', 'https://example.com']);
});

test('checkAppUpdate swallows desktop bridge failures', async () => {
  installWindow({
    droidControl: {
      checkAppUpdate: async () => {
        throw new Error('offline');
      },
    } as Window['droidControl'],
  });

  assert.equal(await checkAppUpdate(), null);
});

test('openExternal falls back to browser window.open outside desktop', async () => {
  const opened: unknown[][] = [];
  installWindow({
    open: (...args: unknown[]) => {
      opened.push(args);
      return null;
    },
  });

  await openExternal('https://example.com');
  assert.deepEqual(opened, [['https://example.com', '_blank', 'noopener']]);
});
