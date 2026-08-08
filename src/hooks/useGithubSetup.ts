import { useCallback, useEffect, useReducer, useRef } from 'react';

import { authenticateGithubCli, getGithubAvailability, installGithubCli } from '../lib/github';
import { openExternal } from '../lib/onboarding';
import type { GithubAvailability, GithubSetupResult } from '../types/vcs';

const GITHUB_CLI_INSTALL_URL = 'https://github.com/cli/cli#installation';

export type GithubSetupAction = 'idle' | 'installing' | 'authenticating';

export interface GithubSetupState {
  requestId: number;
  availability: GithubAvailability | null;
  action: GithubSetupAction;
  error: string | null;
  manualGuideOpened: boolean;
}

type GithubSetupEvent =
  | { type: 'reset'; requestId: number }
  | { type: 'probe-started'; requestId: number }
  | { type: 'probe-finished'; requestId: number; availability: GithubAvailability }
  | {
      type: 'action-started';
      requestId: number;
      action: Exclude<GithubSetupAction, 'idle'>;
    }
  | { type: 'action-failed'; requestId: number; message: string }
  | { type: 'guide-opened'; requestId: number };

export const initialGithubSetupState: GithubSetupState = {
  requestId: 0,
  availability: null,
  action: 'idle',
  error: null,
  manualGuideOpened: false,
};

export function githubSetupReducer(
  state: GithubSetupState,
  event: GithubSetupEvent,
): GithubSetupState {
  if (event.type === 'reset') {
    return { ...initialGithubSetupState, requestId: event.requestId };
  }
  if (event.type === 'probe-started') {
    return { ...state, requestId: event.requestId, error: null };
  }
  if (event.type === 'action-started') {
    return { ...state, requestId: event.requestId, action: event.action, error: null };
  }
  if (event.requestId !== state.requestId) return state;

  switch (event.type) {
    case 'probe-finished':
      return {
        ...state,
        availability: event.availability,
        action: 'idle',
        error: null,
        manualGuideOpened: event.availability.installed ? false : state.manualGuideOpened,
      };
    case 'action-failed':
      return { ...state, action: 'idle', error: event.message };
    case 'guide-opened':
      return { ...state, action: 'idle', error: null, manualGuideOpened: true };
    default:
      return state;
  }
}

export type GithubPrimaryAction = 'install' | 'check' | 'authenticate' | 'none';

export function primaryActionFor(state: GithubSetupState): GithubPrimaryAction {
  if (state.action !== 'idle' || !state.availability) return 'none';
  if (state.availability.installed) {
    return state.availability.authenticated ? 'none' : 'authenticate';
  }
  if (state.availability.installMethod === 'manual' && state.manualGuideOpened) return 'check';
  return 'install';
}

export function shouldRefreshGithubOnVisibility(
  state: GithubSetupState,
  isHidden: boolean,
): boolean {
  return state.manualGuideOpened && !isHidden;
}

export interface GithubSetupController {
  availability: GithubAvailability | null;
  action: GithubSetupAction;
  error: string | null;
  manualGuideOpened: boolean;
  isReady: boolean;
  refresh: () => void;
  runPrimaryAction: () => void;
}

export function useGithubSetup(enabled: boolean, repositoryKey: string): GithubSetupController {
  const [state, dispatch] = useReducer(githubSetupReducer, initialGithubSetupState);
  const requestIdRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const probe = useCallback(
    (requestId: number) => {
      if (!enabled) return;
      dispatch({ type: 'probe-started', requestId });
      void getGithubAvailability().then((availability) => {
        dispatch({ type: 'probe-finished', requestId, availability });
      });
    },
    [enabled],
  );

  const refresh = useCallback(() => {
    const requestId = ++requestIdRef.current;
    probe(requestId);
  }, [probe]);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    dispatch({ type: 'reset', requestId });
    probe(requestId);
  }, [enabled, repositoryKey, probe]);

  const finishOperation = useCallback(
    (requestId: number, result: GithubSetupResult) => {
      if (result.ok) {
        refresh();
        return;
      }
      dispatch({ type: 'action-failed', requestId, message: result.message });
    },
    [refresh],
  );

  const runPrimaryAction = useCallback(() => {
    const current = stateRef.current;
    const primaryAction = primaryActionFor(current);
    if (primaryAction === 'none') return;
    if (primaryAction === 'check') {
      refresh();
      return;
    }

    const requestId = ++requestIdRef.current;
    if (primaryAction === 'authenticate') {
      dispatch({ type: 'action-started', requestId, action: 'authenticating' });
      void authenticateGithubCli().then((result) => {
        finishOperation(requestId, result);
      });
      return;
    }

    dispatch({ type: 'action-started', requestId, action: 'installing' });
    if (current.availability?.installed || current.availability?.installMethod !== 'manual') {
      void installGithubCli().then((result) => {
        finishOperation(requestId, result);
      });
      return;
    }
    void openExternal(GITHUB_CLI_INSTALL_URL)
      .then(() => {
        dispatch({ type: 'guide-opened', requestId });
      })
      .catch(() => {
        dispatch({
          type: 'action-failed',
          requestId,
          message: 'DROIDEX could not open the GitHub CLI installation page.',
        });
      });
  }, [finishOperation, refresh]);

  useEffect(() => {
    if (!state.manualGuideOpened) return;
    const handleVisibility = () => {
      if (shouldRefreshGithubOnVisibility(stateRef.current, document.hidden)) refresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refresh, state.manualGuideOpened]);

  return {
    availability: state.availability,
    action: state.action,
    error: state.error,
    manualGuideOpened: state.manualGuideOpened,
    isReady: state.availability?.installed === true && state.availability.authenticated,
    refresh,
    runPrimaryAction,
  };
}
