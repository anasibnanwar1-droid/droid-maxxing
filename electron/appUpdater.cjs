function createAppUpdater(options) {
  const updater = options.autoUpdater;
  const scheduleInstall = options.scheduleInstall || setImmediate;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const installMode = options.installMode || 'automatic';
  const fetchText = options.fetchText || defaultFetchText;
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
        // This appcast read controls only the sidebar hint. Sparkle still owns
        // update presentation, signature verification, download, and install.
        if (checkOptions.interactive === true) {
          options.sparkleUpdater().checkForUpdates(true, true, false);
        }
        let latest = '';
        try {
          latest = parseSparkleVersion(await fetchText(options.sparkleFeedUrl));
        } catch (error) {
          options.logError?.('Sparkle appcast check failed', error);
        }
        return updateInfo(
          current,
          latest,
          compareSemverParts(latest, current) > 0,
          platform,
          arch,
          installMode,
        );
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
      throw new Error('App updates are available only in the packaged macOS app.');
    }
    if (installMode === 'sparkle') {
      options.sparkleUpdater().checkForUpdates(true, true, false);
      return { status: 'presented' };
    }
    await updater.downloadUpdate();
    await options.prepareToInstall();
    scheduleInstall(() => updater.quitAndInstall(false, true));
    return { status: 'downloaded' };
  }

  return { check, downloadAndInstall };
}

async function defaultFetchText(url) {
  if (!url) throw new Error('Sparkle feed URL is missing.');
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Sparkle appcast returned HTTP ${response.status}.`);
  return readBoundedText(response);
}

async function readBoundedText(response, maxBytes = 256 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new Error('Sparkle appcast exceeds the size limit.');
    }
    text += decoder.decode(value, { stream: true });
  }
}

function parseSparkleVersion(appcast) {
  const version = String(appcast).match(
    /<sparkle:shortVersionString>\s*([^<]+?)\s*<\/sparkle:shortVersionString>/,
  )?.[1];
  if (!version || version.length > 64 || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Sparkle appcast has no valid release version.');
  }
  return version;
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

module.exports = { createAppUpdater, compareSemverParts, parseSparkleVersion, readBoundedText };
