function createAppUpdater(options) {
  const updater = options.autoUpdater;
  const scheduleInstall = options.scheduleInstall || setImmediate;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const installMode = options.installMode || 'automatic';
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;

  async function check(checkOptions = {}) {
    const current = options.app.getVersion();
    if (!options.app.isPackaged || platform !== 'darwin') {
      return updateInfo(current, current, false, platform, arch, installMode);
    }
    try {
      if (installMode === 'sparkle') {
        options
          .sparkleUpdater()
          .checkForUpdates(
            checkOptions.interactive === true,
            checkOptions.automaticChecks !== false,
          );
        return updateInfo(current, current, false, platform, arch, installMode);
      }
      const latest = String((await updater.checkForUpdates())?.updateInfo?.version || current);
      return updateInfo(
        current,
        latest,
        compareSemverParts(latest, current) > 0,
        platform,
        arch,
        installMode,
      );
    } catch (error) {
      options.logError?.('update check failed', error);
      return updateInfo(current, '', false, platform, arch, installMode);
    }
  }

  async function downloadAndInstall() {
    if (!options.app.isPackaged || platform !== 'darwin') {
      throw new Error('Automatic updates are available only in the packaged macOS app.');
    }
    if (installMode === 'sparkle') {
      options.sparkleUpdater().checkForUpdates(true, true);
      return { status: 'presented' };
    }
    await updater.downloadUpdate();
    await options.prepareToInstall();
    scheduleInstall(() => updater.quitAndInstall(false, true));
    return { status: 'downloaded' };
  }

  return { check, downloadAndInstall };
}

function updateInfo(current, latest, updateAvailable, platform, arch, installMode = 'automatic') {
  return {
    current,
    latest,
    updateAvailable,
    arch,
    platform,
    installMode,
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
