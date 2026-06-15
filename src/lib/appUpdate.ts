import { useEffect, useState } from 'react';
import {
  checkAppUpdate as ipcCheck,
  downloadAppUpdate as ipcDownload,
  type AppUpdateInfo,
} from './onboarding';
import { toast } from './toast';

// Shared, subscribable app-update state so the sidebar header button, the
// settings panel, and the launch check all read the same source of truth.
let info: AppUpdateInfo | null = null;
let downloading = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getAppUpdate(): AppUpdateInfo | null {
  return info;
}

export async function refreshAppUpdate(): Promise<AppUpdateInfo | null> {
  const next = await ipcCheck();
  // Only surface a positive result; failures or up-to-date checks must not
  // clobber a previously found update.
  if (next?.updateAvailable) {
    info = next;
    emit();
  }
  return next;
}

// Downloads the artifact selected by the manifest and (on the autoUpdater feed
// path) restarts the app to finish installing.
export async function startAppUpdate(target: AppUpdateInfo | null = info): Promise<void> {
  if (downloading) return;
  downloading = true;
  emit();
  try {
    const result = await ipcDownload(target?.dmgUrl);
    // The feed path can resolve as already up to date (e.g. a launch probe with
    // only a feed configured); don't show a misleading "downloading" toast then.
    if (result?.status !== 'up-to-date') {
      toast.info('Downloading the update. The app will restart to finish installing.');
    }
  } catch {
    toast.error('Update download failed. Please try again.');
  } finally {
    downloading = false;
    emit();
  }
}

export function useAppUpdate(): {
  update: AppUpdateInfo | null;
  downloading: boolean;
  start: () => Promise<void>;
} {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return { update: info, downloading, start: () => startAppUpdate() };
}
