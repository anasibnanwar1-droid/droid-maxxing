import { normalizeUrl } from './browserViewport';

export const DEFAULT_BROWSER_URL = 'about:blank';

export function safeBrowserUrl(value: string | undefined, appOrigin: string | undefined): string {
  if (isInternalBrowserUrl(value)) return DEFAULT_BROWSER_URL;
  const normalized = value ? normalizeUrl(value) : DEFAULT_BROWSER_URL;
  return isSelfBrowserUrl(normalized, appOrigin) ? DEFAULT_BROWSER_URL : normalized;
}

export function isSelfBrowserUrl(value: string, appOrigin: string | undefined): boolean {
  if (!appOrigin || value === DEFAULT_BROWSER_URL) return false;
  try {
    return new URL(value, appOrigin).origin === appOrigin;
  } catch {
    return false;
  }
}

function isInternalBrowserUrl(value: string | undefined): boolean {
  return Boolean(value && /^chrome-error:\/\//i.test(value.trim()));
}
