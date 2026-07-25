export interface BrowserLoadingIdentity {
  browserKey?: string;
  sessionId?: string;
}

export function shouldResetBrowserLoading(
  previous: BrowserLoadingIdentity,
  next: BrowserLoadingIdentity,
): boolean {
  if (previous.browserKey !== next.browserKey) return true;
  return Boolean(previous.sessionId && previous.sessionId !== next.sessionId);
}
