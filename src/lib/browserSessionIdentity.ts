import type { SessionSummary } from '../types/bridge';

export function browserKeyForSession(session: SessionSummary | undefined): string | undefined {
  if (!session) return undefined;
  // The backend keys browser sessions by the stable app session id, which never
  // changes (compaction swaps providerSessionId, but the browser key must not).
  return session.appSessionId;
}

export function nativeBrowserRequestTargetsActiveSession(
  activeBrowserKey: string | undefined,
  requestAppSessionId: string,
): boolean {
  return activeBrowserKey !== undefined && activeBrowserKey === requestAppSessionId;
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
