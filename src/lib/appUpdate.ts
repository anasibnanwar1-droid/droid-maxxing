import { useEffect, useState } from 'react';
import {
  checkAppUpdate as ipcCheck,
  downloadAppUpdate as ipcDownload,
  type AppUpdateCheckOptions,
  type AppUpdateInfo,
} from './onboarding';
import { toast } from './toast';

// Shared, subscribable app-update state so the sidebar footer button, the
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

export function shouldInstallAppUpdateAutomatically(update: AppUpdateInfo | null): boolean {
  return update?.updateAvailable === true && update.installMode === 'automatic';
}

export async function refreshAppUpdate(
  options: AppUpdateCheckOptions,
): Promise<AppUpdateInfo | null> {
  const next = await ipcCheck(options);
  // Only surface a positive result; failures or up-to-date checks must not
  // clobber a previously found update.
  if (next?.updateAvailable) {
    info = next;
    emit();
  }
  return next;
}

export async function startAppUpdate(target: AppUpdateInfo | null = info): Promise<void> {
  if (downloading || !target?.updateAvailable) return;
  downloading = true;
  emit();
  try {
    const result = await ipcDownload();
    if (result?.status === 'downloaded') {
      toast.info('Update downloaded. Restarting DROIDEX…');
    } else if (result?.status === 'presented') {
      toast.info('Sparkle opened the verified update flow.');
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
    const listener = () => {
      force((n) => n + 1);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return {
    update: info,
    downloading,
    start: async () => {
      await startAppUpdate();
    },
  };
}
