import { useCallback, useEffect, useRef } from 'react';
import {
  ackNotificationActivate,
  isDesktop,
  notify,
  onNotificationActivate,
  takePendingNotificationSession,
} from '../lib/desktop';
import {
  collectFinishedSessions,
  decideFinishNotification,
  isAppInForeground,
  latestAssistantSnippet,
  loadFinishNotificationSettings,
} from '../lib/finishNotifications';
import { useStore } from './useStore';

// Desktop finish banners: working→idle sessions raise a short OS notification.
// Clicks must open that exact chat even when the user was in Safari on another
// session — main queues the target; we apply it via push IPC + focus pull.

export function useFinishNotifications(enabled: boolean): void {
  const { state, dispatch } = useStore();
  const previouslyWorking = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  const settingsOpenRef = useRef(state.settingsOpen);
  settingsOpenRef.current = state.settingsOpen;
  const sessionsRef = useRef(state.sessions);
  sessionsRef.current = state.sessions;
  // Avoid double-applying the same open if push and pull both fire.
  const lastOpenedRef = useRef<{ id: string; at: number } | null>(null);

  const openSessionFromNotification = useCallback(
    (appSessionId: string) => {
      if (!appSessionId) return;
      // Only jump when we still know this chat; avoids blanking the UI if the
      // session was closed after the banner was shown.
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

  // Push path: main sends notification-activate after click / focus retry.
  useEffect(() => {
    if (!enabled || !isDesktop()) return;
    return onNotificationActivate(({ appSessionId }) => {
      if (appSessionId) openSessionFromNotification(appSessionId);
    });
  }, [enabled, openSessionFromNotification]);

  // Pull path: when we become visible/focused after a notification click,
  // reclaim any pending open the push event might have missed.
  useEffect(() => {
    if (!enabled || !isDesktop()) return;

    const pullPending = () => {
      void takePendingNotificationSession().then((pending) => {
        if (pending?.appSessionId) openSessionFromNotification(pending.appSessionId);
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') pullPending();
    };

    window.addEventListener('focus', pullPending);
    document.addEventListener('visibilitychange', onVisibility);
    pullPending();

    return () => {
      window.removeEventListener('focus', pullPending);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, openSessionFromNotification]);

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
    const appInForeground = isAppInForeground();

    for (const session of finished) {
      const decision = decideFinishNotification({
        settings,
        session,
        isActiveSession: session.appSessionId === state.activeAppSessionId,
        assistantSnippet: latestAssistantSnippet(state.transcripts[session.appSessionId]),
        appInForeground,
      });
      if (decision.kind !== 'notify') continue;

      void notify(decision.title, decision.body, {
        silent: decision.silent,
        suppressWhenFocused: false,
        appSessionId: session.appSessionId,
      }).catch(() => {
        /* permission denied or non-desktop — stay quiet */
      });
    }
  }, [enabled, state.sessions, state.transcripts, state.activeAppSessionId]);
}
