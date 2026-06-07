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
    const app = new URL(appOrigin);
    const target = new URL(value, appOrigin);
    if (app.protocol !== target.protocol) return false;
    if (portFor(app) !== portFor(target)) return false;
    if (isLoopbackHost(app.hostname) && isLoopbackHost(target.hostname)) return true;
    return target.hostname === app.hostname;
  } catch {
    return false;
  }
}

function isInternalBrowserUrl(value: string | undefined): boolean {
  return Boolean(value && /^chrome-error:\/\//i.test(value.trim()));
}

function portFor(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]';
}
