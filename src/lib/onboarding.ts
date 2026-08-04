import { isDesktop } from './desktop';

export interface OnboardingState {
  completed: boolean;
  version: number;
  defaultEditor?: string;
  installChannel?: 'script' | 'brew' | 'npm';
  cliAutoUpdate?: boolean;
  appAutoUpdate?: boolean;
}

export interface AppUpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  arch: string;
  platform: string;
  installMode: 'automatic' | 'sparkle';
}

export async function getOnboarding(): Promise<OnboardingState> {
  if (!isDesktop()) return { completed: true, version: 1 };
  return window.droidControl!.getOnboarding();
}

export async function setOnboarding(patch: Partial<OnboardingState>): Promise<OnboardingState> {
  if (!isDesktop()) return { completed: true, version: 1, ...patch };
  return window.droidControl!.setOnboarding(patch);
}

export async function getAppVersion(): Promise<string> {
  if (!isDesktop()) return '0.0.0';
  return window.droidControl!.appVersion();
}

export interface AppUpdateCheckOptions {
  interactive: boolean;
  automaticChecks: boolean;
  configureAutomaticChecks?: boolean;
}

export async function checkAppUpdate(
  options: AppUpdateCheckOptions,
): Promise<AppUpdateInfo | null> {
  if (!isDesktop()) return null;
  try {
    return await window.droidControl!.checkAppUpdate(options);
  } catch {
    return null;
  }
}

export interface AppUpdateResult {
  status: 'downloaded' | 'presented';
}

export async function downloadAppUpdate(): Promise<AppUpdateResult | null> {
  if (!isDesktop()) return null;
  return window.droidControl!.downloadAppUpdate();
}

export async function relaunchApp(): Promise<void> {
  if (!isDesktop()) return;
  await window.droidControl!.relaunchApp();
}

export async function openExternal(url: string): Promise<void> {
  if (!isDesktop()) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  await window.droidControl!.openExternal(url);
}
