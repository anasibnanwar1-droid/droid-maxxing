export interface BrowserLoadingIdentity {
  browserKey?: string;
  browserSessionId?: string;
}

export function shouldResetBrowserLoading(
  previous: BrowserLoadingIdentity,
  next: BrowserLoadingIdentity,
): boolean {
  if (previous.browserKey !== next.browserKey) return true;
  return Boolean(previous.browserSessionId && previous.browserSessionId !== next.browserSessionId);
}
