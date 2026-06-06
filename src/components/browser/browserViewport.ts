import type { BrowserViewport, BrowserViewportMode } from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';

export const FIT_FALLBACK_VIEWPORT: BrowserViewport = { width: 1200, height: 800, deviceScaleFactor: 1 };
export const CUSTOM_DEFAULT_VIEWPORT: BrowserViewport = { width: 1024, height: 720, deviceScaleFactor: 1 };

export const PRESET_VIEWPORTS: Partial<Record<BrowserViewportMode, BrowserViewport>> = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  laptop: { width: 1280, height: 800, deviceScaleFactor: 1 },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2 },
};

export function viewportFromFrame(size: Size): BrowserViewport {
  if (size.width <= 1 || size.height <= 1) return FIT_FALLBACK_VIEWPORT;
  return {
    width: even(clamp(size.width - 96, 390, 1440)),
    height: even(clamp(size.height - 112, 360, 1000)),
    deviceScaleFactor: 1,
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
  return a.width === b.width && a.height === b.height && a.deviceScaleFactor === b.deviceScaleFactor;
}

export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  if (/^(https?:|file:|about:)/i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}
