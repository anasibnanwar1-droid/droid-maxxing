import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../lib/bridge';
import { connect, detectEnv, installCli, startCliLogin, updateCli } from '../lib/commands';
import { setApiKey as persistApiKey } from '../lib/desktop';
import { getOnboarding, setOnboarding, type OnboardingState } from '../lib/onboarding';
import type { EnvironmentReport, InstallChannel } from '../types/bridge';

export interface RuntimeStatus {
  mode: 'cli_auth';
  droidPath: string;
  apiKeyConfigured: boolean;
}

export interface OnboardingController {
  ready: boolean;
  onboarding: OnboardingState | null;
  env: EnvironmentReport | null;
  runtime: RuntimeStatus | null;
  installLog: string[];
  installing: 'install' | 'update' | null;
  lastResult: { phase: 'install' | 'update'; ok: boolean } | null;
  refreshEnv: () => void;
  install: (channel: InstallChannel) => void;
  update: (channel?: InstallChannel) => void;
  login: () => void;
  saveApiKey: (key: string) => Promise<void>;
  patch: (p: Partial<OnboardingState>) => Promise<void>;
}

export function useOnboarding(): OnboardingController {
  const [ready, setReady] = useState(false);
  const [onboarding, setOnboardingState] = useState<OnboardingState | null>(null);
  const [env, setEnv] = useState<EnvironmentReport | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installing, setInstalling] = useState<'install' | 'update' | null>(null);
  const [lastResult, setLastResult] = useState<{ phase: 'install' | 'update'; ok: boolean } | null>(
    null,
  );
  const reDetectedForKey = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void getOnboarding().then((state) => {
      if (!cancelled) {
        setOnboardingState(state);
        setReady(true);
      }
    });
    detectEnv();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsub = bridge.subscribe((ev) => {
      switch (ev.type) {
        case 'runtime.updated':
          setRuntime(ev.status);
          // App restores a saved API key via connect() after the initial
          // detect; connect only emits runtime.updated, so re-detect once to
          // refresh auth state instead of leaving the user shown as signed out.
          if (ev.status.apiKeyConfigured && !reDetectedForKey.current) {
            reDetectedForKey.current = true;
            detectEnv();
          }
          break;
        case 'env.report':
          setEnv(ev.report);
          break;
        case 'cli.install.progress':
          setInstalling(ev.phase);
          setInstallLog((log) => [...log.slice(-400), ev.line]);
          break;
        case 'cli.install.done':
          setInstalling(null);
          setLastResult({ phase: ev.phase, ok: ev.ok });
          break;
      }
    });
    return () => {
      unsub();
    };
  }, []);

  const refreshEnv = useCallback(() => detectEnv(), []);

  const install = useCallback((channel: InstallChannel) => {
    setInstallLog([]);
    setLastResult(null);
    setInstalling('install');
    // Remember the channel so later CLI updates use the matching updater path.
    void setOnboarding({ installChannel: channel }).then(setOnboardingState);
    installCli(channel);
  }, []);

  const update = useCallback((channel?: InstallChannel) => {
    setInstallLog([]);
    setLastResult(null);
    setInstalling('update');
    updateCli(channel);
  }, []);

  const login = useCallback(() => startCliLogin(), []);

  const saveApiKey = useCallback(async (key: string) => {
    await persistApiKey(key.trim());
    connect(key.trim());
    detectEnv();
  }, []);

  const patch = useCallback(async (p: Partial<OnboardingState>) => {
    const next = await setOnboarding(p);
    setOnboardingState(next);
  }, []);

  return {
    ready,
    onboarding,
    env,
    runtime,
    installLog,
    installing,
    lastResult,
    refreshEnv,
    install,
    update,
    login,
    saveApiKey,
    patch,
  };
}

// Decides whether the full first-run tour should appear. Only when onboarding
// has never been completed; afterward the app surfaces a slim banner instead.
export function shouldShowOnboarding(
  onboarding: Pick<OnboardingState, 'completed'> | null,
): boolean {
  if (!onboarding) return false;
  return !onboarding.completed;
}

// A hard blocker means the app cannot run agents: no CLI, or not signed in.
export function hasSetupBlocker(env: EnvironmentReport | null): boolean {
  if (!env) return false;
  if (!env.cli.present) return true;
  return !env.auth.loginPresent && !env.auth.apiKeyConfigured;
}
