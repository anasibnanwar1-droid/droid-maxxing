import type { BrowserNativeRequest, SessionSummary } from '../types/bridge';

export function browserKeyForSession(session: SessionSummary | undefined): string | undefined {
  if (!session) return undefined;
  // The backend keys browser sessions by the stable app session id, which never
  // changes (compaction swaps providerSessionId, but the browser key must not).
  return session.appSessionId;
}

export function activeSessionAfterNativeBrowserRequest(
  activeAppSessionId: string | null,
  request: BrowserNativeRequest,
  sessions: Record<string, SessionSummary> = {},
): string | null {
  return activeAppSessionId ?? appSessionIdForBrowserKey(sessions, request.appSessionId);
}

export function appSessionIdForBrowserKey(
  sessions: Record<string, SessionSummary>,
  browserKey: string,
): string {
  return (
    Object.values(sessions).find((session) => browserKeyForSession(session) === browserKey)
      ?.appSessionId ?? browserKey
  );
}

export function nativeBrowserRequestTargetsVisibleSurface(input: {
  browserKey: string;
  visibleBrowserSessionId?: string;
  requestAppSessionId: string;
  requestBrowserSessionId: string;
}): boolean {
  return (
    input.browserKey === input.requestAppSessionId ||
    input.visibleBrowserSessionId === input.requestBrowserSessionId
  );
}
