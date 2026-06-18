import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getAppUpdate, refreshAppUpdate, startAppUpdate } from './appUpdate';
import { __resetToasts, subscribeToasts } from './toast';
import type { AppUpdateInfo } from './onboarding';

type TestWindow = typeof globalThis & { window?: Window & typeof globalThis };

function clearWindow(): void {
  delete (globalThis as TestWindow).window;
}

function installDesktopApi(api: Partial<NonNullable<Window['droidControl']>>): void {
  (globalThis as TestWindow).window = { droidControl: api } as Window & typeof globalThis;
}

afterEach(() => {
  __resetToasts();
  clearWindow();
});

test('refreshAppUpdate stores only positive update checks and startAppUpdate reports results', async () => {
  __resetToasts();
  const latestToasts: string[] = [];
  const unsubscribe = subscribeToasts((items) => {
    latestToasts.splice(0, latestToasts.length, ...items.map((item) => item.message));
  });
  const update: AppUpdateInfo = {
    current: '1.0.0',
    latest: '1.2.0',
    updateAvailable: true,
    arch: 'arm64',
    platform: 'darwin',
    dmgUrl: 'https://example.com/app.dmg',
    feedConfigured: true,
  };
  const downloadedUrls: Array<string | undefined> = [];

  installDesktopApi({
    checkAppUpdate: async () => ({ ...update, updateAvailable: false }),
    downloadAppUpdate: async (dmgUrl) => {
      downloadedUrls.push(dmgUrl);
      return { mode: 'download', status: 'downloaded' };
    },
  });
  assert.equal((await refreshAppUpdate())?.updateAvailable, false);
  assert.equal(getAppUpdate(), null);

  installDesktopApi({
    checkAppUpdate: async () => update,
    downloadAppUpdate: async (dmgUrl) => {
      downloadedUrls.push(dmgUrl);
      return { mode: 'download', status: 'downloaded' };
    },
  });
  assert.deepEqual(await refreshAppUpdate(), update);
  assert.deepEqual(getAppUpdate(), update);

  await startAppUpdate();
  assert.deepEqual(downloadedUrls, ['https://example.com/app.dmg']);
  assert.deepEqual(latestToasts, [
    'Downloading the update. The app will restart to finish installing.',
  ]);

  installDesktopApi({
    downloadAppUpdate: async () => {
      throw new Error('network down');
    },
  });
  await startAppUpdate(update);
  assert.equal(latestToasts.at(-1), 'Update download failed. Please try again.');
  unsubscribe();
});
