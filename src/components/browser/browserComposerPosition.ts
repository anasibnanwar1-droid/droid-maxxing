import type { CSSProperties } from 'react';
import type {
  BrowserBox,
  BrowserViewport,
  BrowserViewportMode,
  DesignReference,
} from '../../types/bridge';
import type { Size } from '../canvas/canvasMath';
import { clamp } from './browserViewport';

export function composerStyleForReferences(
  references: DesignReference[],
  frame: Size,
  viewport: BrowserViewport,
  mode: BrowserViewportMode,
): CSSProperties {
  const surface = surfaceLayout(frame, viewport, mode);
  const box = unionBoxes(
    references.map(boxForReference).filter((item): item is BrowserBox => Boolean(item)),
  ) ?? {
    x: 0,
    y: 0,
    width: surface.width,
    height: 1,
  };
  const composerWidth = Math.min(420, Math.max(280, frame.width - 24));
  const composerHeight = 112;
  const left = surface.left + box.x;
  const belowTop = surface.top + box.y + box.height + 10;
  const aboveTop = surface.top + box.y - composerHeight - 10;
  const top = belowTop + composerHeight <= frame.height - 12 ? belowTop : aboveTop;
  return {
    left: clamp(left, 12, Math.max(12, frame.width - composerWidth - 12)),
    top: clamp(top, 12, Math.max(12, frame.height - composerHeight - 12)),
  };
}

function surfaceLayout(
  frame: Size,
  viewport: BrowserViewport,
  mode: BrowserViewportMode,
): Size & { left: number; top: number } {
  const padding = 18;
  const availableWidth = Math.max(1, frame.width - padding * 2);
  const availableHeight = Math.max(1, frame.height - padding * 2);
  const width = mode === 'fit' ? availableWidth : Math.min(viewport.width, availableWidth);
  const height = mode === 'fit' ? availableHeight : Math.min(viewport.height, availableHeight);
  return {
    width: Math.round(width),
    height: Math.round(height),
    left: Math.round((frame.width - width) / 2),
    top: Math.round((frame.height - height) / 2),
  };
}

function boxForReference(reference: DesignReference): BrowserBox | undefined {
  return reference.anchor?.box;
}

function unionBoxes(boxes: BrowserBox[]): BrowserBox | undefined {
  if (boxes.length === 0) return undefined;
  const x1 = Math.min(...boxes.map((box) => box.x));
  const y1 = Math.min(...boxes.map((box) => box.y));
  const x2 = Math.max(...boxes.map((box) => box.x + box.width));
  const y2 = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
