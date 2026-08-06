import { useEffect, useRef } from 'react';
import { useStore } from './useStore';
import { addDiagnosticsBreadcrumb, setDiagnosticsContext } from '../lib/rendererDiagnostics';

/**
 * Keeps Sentry app-state context and the session-log ring buffer in sync with
 * operational state transitions. Only anonymized operational facts (mode,
 * autonomy level, session count, active view) are recorded — never prompts,
 * messages, file paths, or credentials.
 */
export function useDiagnosticsContext(): void {
  const { state } = useStore();
  const sessionCount = Object.keys(state.sessions).length;
  const activeSession = state.activeAppSessionId
    ? state.sessions[state.activeAppSessionId]
    : undefined;
  const prevCount = useRef(sessionCount);
  const prevMode = useRef(activeSession?.interactionMode);
  const prevAutonomy = useRef(activeSession?.autonomy);

  useEffect(() => {
    setDiagnosticsContext({
      interactionMode: activeSession?.interactionMode,
      autonomy: activeSession?.autonomy,
      activeSessionCount: sessionCount,
      view: activeSession?.sessionPurpose ?? 'chat',
    });
  }, [
    activeSession?.interactionMode,
    activeSession?.autonomy,
    activeSession?.sessionPurpose,
    sessionCount,
  ]);

  useEffect(() => {
    if (prevCount.current !== sessionCount) {
      addDiagnosticsBreadcrumb(
        'session',
        sessionCount > prevCount.current ? 'session opened' : 'session closed',
      );
      prevCount.current = sessionCount;
    }
  }, [sessionCount]);

  useEffect(() => {
    const mode = activeSession?.interactionMode;
    if (prevMode.current !== mode) {
      addDiagnosticsBreadcrumb('session', `mode changed to ${mode ?? 'unknown'}`);
    }
    prevMode.current = mode;
  }, [activeSession?.interactionMode]);

  useEffect(() => {
    const autonomy = activeSession?.autonomy;
    if (prevAutonomy.current !== autonomy) {
      addDiagnosticsBreadcrumb('session', `autonomy changed to ${autonomy ?? 'unknown'}`);
    }
    prevAutonomy.current = autonomy;
  }, [activeSession?.autonomy]);

  useEffect(() => {
    addDiagnosticsBreadcrumb('app', 'app focused');
    const onBlur = () => {
      addDiagnosticsBreadcrumb('app', 'app blurred');
    };
    const onFocus = () => {
      addDiagnosticsBreadcrumb('app', 'app focused');
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}
