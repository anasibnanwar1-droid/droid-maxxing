import { useCallback, useEffect, useRef } from 'react';
import {
  ackNotificationActivate,
  isDesktop,
  notify,
  onNotificationActivate,
  takePendingNotificationSession,
} from '../lib/desktop';
import { isDocumentVisible, subscribeVisibilityChange } from './useDocumentVisible';
import {
  collectFinishedSessions,
  decideFinishNotification,
  isAppInForeground,
  latestAssistantSnippet,
  loadFinishNotificationSettings,
} from '../lib/finishNotifications';
import { useStore } from './useStore';

// Desktop finish banners: working→idle sessions raise a short OS notification.
// Clicks open that chat via a main-process pending queue (push + focus pull).

export function useFinishNotifications(enabled: boolean): void {
  const { state, dispatch } = useStore();
  const previouslyWorking = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  const settingsOpenRef = useRef(state.settingsOpen);
  settingsOpenRef.current = state.settingsOpen;
  const sessionsRef = useRef(state.sessions);
  sessionsRef.current = state.sessions;
  const transcriptsRef = useRef(state.transcripts);
  transcriptsRef.current = state.transcripts;
  const activeIdRef = useRef(state.activeAppSessionId);
  activeIdRef.current = state.activeAppSessionId;
  const lastOpenedRef = useRef<{ id: string; at: number } | null>(null);

  const openSessionFromNotification = useCallback(
    (appSessionId: string) => {
      if (!appSessionId) return;
      if (!(appSessionId in sessionsRef.current)) {
        void ackNotificationActivate(appSessionId);
        return;
      }
      const now = Date.now();
      if (lastOpenedRef.current?.id === appSessionId && now - lastOpenedRef.current.at < 1500) {
        void ackNotificationActivate(appSessionId);
        return;
      }
      lastOpenedRef.current = { id: appSessionId, at: now };
      dispatch({ type: 'SET_ACTIVE_SESSION', id: appSessionId });
      dispatch({ type: 'SELECT_CHILD', selection: null });
      if (settingsOpenRef.current) dispatch({ type: 'TOGGLE_SETTINGS' });
      void ackNotificationActivate(appSessionId);
    },
    [dispatch],
  );

  useEffect(() => {
    if (!enabled || !isDesktop()) return;
    return onNotificationActivate(({ appSessionId }) => {
      if (appSessionId) openSessionFromNotification(appSessionId);
    });
  }, [enabled, openSessionFromNotification]);

  useEffect(() => {
    if (!enabled || !isDesktop()) return;

    const pullPending = () => {
      void takePendingNotificationSession().then((pending) => {
        if (pending?.appSessionId) openSessionFromNotification(pending.appSessionId);
      });
    };

    const onVisibility = () => {
      if (isDocumentVisible()) pullPending();
    };

    window.addEventListener('focus', pullPending);
    const unsubVisibility = subscribeVisibilityChange(onVisibility);
    pullPending();

    return () => {
      window.removeEventListener('focus', pullPending);
      unsubVisibility();
    };
  }, [enabled, openSessionFromNotification]);

  // Only re-run on session summary changes (streaming/phase), not transcript tokens.
  useEffect(() => {
    if (!enabled || !isDesktop()) return;

    const { finished, stillWorking } = collectFinishedSessions({
      sessions: state.sessions,
      previouslyWorking: previouslyWorking.current,
    });

    if (!seeded.current) {
      previouslyWorking.current = stillWorking;
      seeded.current = true;
      return;
    }

    previouslyWorking.current = stillWorking;
    if (finished.length === 0) return;

    const settings = loadFinishNotificationSettings();
    if (!settings.enabled) return;
    const appInForeground = isAppInForeground();
    if (settings.suppressWhenFocused && appInForeground) return;

    for (const session of finished) {
      // Build snippet only when we may actually notify this session.
      const isActive = session.appSessionId === activeIdRef.current;
      if (!settings.notifyActiveSession && isActive) continue;

      const decision = decideFinishNotification({
        settings,
        session,
        isActiveSession: isActive,
        assistantSnippet: latestAssistantSnippet(transcriptsRef.current[session.appSessionId]),
        appInForeground,
      });
      if (decision.kind !== 'notify') continue;

      void notify(decision.title, decision.body, {
        silent: decision.silent,
        appSessionId: session.appSessionId,
      }).catch(() => {
        /* permission denied or non-desktop — stay quiet */
      });
    }
  }, [enabled, state.sessions]);
}
