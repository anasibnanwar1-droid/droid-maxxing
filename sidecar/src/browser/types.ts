export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export type BrowserViewportMode = 'fit' | 'desktop' | 'laptop' | 'tablet' | 'mobile' | 'custom';

export interface BrowserBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserElementRef {
  ref: string;
  selector: string;
  tagName: string;
  role?: string;
  name?: string;
  text?: string;
  attributes: Record<string, string>;
  className?: string;
  box: BrowserBox;
  computedStyles: Record<string, string>;
}

export interface BrowserSnapshot {
  url: string;
  title?: string;
  scroll: { x: number; y: number };
  refs: BrowserElementRef[];
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';
