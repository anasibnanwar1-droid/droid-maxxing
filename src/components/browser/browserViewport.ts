import type { BrowserViewport, BrowserViewportMode } from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';

export const FIT_FALLBACK_VIEWPORT: BrowserViewport = {
  width: 1200,
  height: 800,
  deviceScaleFactor: 2,
};
export const CUSTOM_DEFAULT_VIEWPORT: BrowserViewport = {
  width: 1024,
  height: 720,
  deviceScaleFactor: 2,
};

export const PRESET_VIEWPORTS: Partial<Record<BrowserViewportMode, BrowserViewport>> = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
  laptop: { width: 1280, height: 800, deviceScaleFactor: 2 },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2 },
};

export function viewportFromFrame(size: Size): BrowserViewport {
  if (size.width <= 1 || size.height <= 1) return FIT_FALLBACK_VIEWPORT;
  return {
    width: even(clamp(size.width - 72, 390, 1440)),
    height: even(clamp(size.height - 96, 360, 1100)),
    deviceScaleFactor: 2,
  };
}

export function viewportForMode(
  mode: BrowserViewportMode,
  fitViewport: BrowserViewport,
  customViewport: BrowserViewport,
): BrowserViewport {
  if (mode === 'fit') return fitViewport;
  if (mode === 'custom') return customViewport;
  return PRESET_VIEWPORTS[mode] ?? fitViewport;
}

export function sameViewport(a: BrowserViewport, b: BrowserViewport): boolean {
  return (
    a.width === b.width && a.height === b.height && a.deviceScaleFactor === b.deviceScaleFactor
  );
}

export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  if (/^(https?:|file:|about:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  const ipv6Loopback = normalizeBareIpv6Loopback(trimmed);
  if (ipv6Loopback) return ipv6Loopback;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?(\/|$)/i.test(trimmed))
    return `http://${trimmed}`;
  return `https://${trimmed}`;
}

function normalizeBareIpv6Loopback(value: string): string | null {
  const match = /^::1(?::(\d+))?(\/.*)?$/i.exec(value);
  if (!match) return null;
  const port = match[1] ? `:${match[1]}` : '';
  const path = match[2] ?? '';
  return `http://[::1]${port}${path}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}
