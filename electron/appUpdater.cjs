function createAppUpdater(options) {
  const updater = options.autoUpdater;
  const scheduleInstall = options.scheduleInstall || setImmediate;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;

  async function check() {
    const current = options.app.getVersion();
    if (!options.app.isPackaged || platform !== 'darwin') {
      return updateInfo(current, current, false, platform, arch);
    }
    try {
      const result = await updater.checkForUpdates();
      const latest = String(result?.updateInfo?.version || current);
      return updateInfo(current, latest, compareSemverParts(latest, current) > 0, platform, arch);
    } catch (error) {
      options.logError?.('update check failed', error);
      return updateInfo(current, '', false, platform, arch);
    }
  }

  async function downloadAndInstall() {
    if (!options.app.isPackaged || platform !== 'darwin') {
      throw new Error('Automatic updates are available only in the packaged macOS app.');
    }
    await updater.downloadUpdate();
    await options.prepareToInstall();
    scheduleInstall(() => updater.quitAndInstall(false, true));
    return { mode: 'autoUpdater', status: 'downloaded' };
  }

  return { check, downloadAndInstall };
}

function updateInfo(current, latest, updateAvailable, platform, arch) {
  return {
    current,
    latest,
    updateAvailable,
    arch,
    platform,
    feedConfigured: false,
  };
}

function compareSemverParts(a, b) {
  const left = String(a).match(/\d+/g)?.map(Number) ?? [];
  const right = String(b).match(/\d+/g)?.map(Number) ?? [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

module.exports = { createAppUpdater, compareSemverParts };
