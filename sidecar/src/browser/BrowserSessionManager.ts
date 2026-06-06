import { randomUUID } from 'node:crypto';
import { MacChromeCdpRuntime } from './MacChromeCdpRuntime.js';
import { formatDesignPrompt, writeDesignPromptPack } from './designPromptPacks.js';
import type {
  BrowserElementRef,
  BrowserState,
  BrowserViewport,
  BrowserViewportMode,
  DesignReference,
  ScrollDirection,
} from './types.js';

export interface BrowserSessionManagerOptions {
  emit?: (event: { type: 'browser.updated'; state: BrowserState } | { type: 'browser.error'; missionId?: string; message: string }) => void;
  runtimeFactory?: (sessionId: string, viewport: BrowserViewport) => BrowserRuntime;
  assetUrlFor?: (path: string) => string;
  writePack?: typeof writeDesignPromptPack;
}

export interface BrowserRuntime {
  open(url: string): Promise<{ url: string; title?: string; scroll: { x: number; y: number }; refs: BrowserElementRef[] }>;
  setViewport(viewport: BrowserViewport): Promise<void>;
  screenshot(fullPage?: boolean): Promise<string>;
  snapshot(): Promise<{ url: string; title?: string; scroll: { x: number; y: number }; refs: BrowserElementRef[] }>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  keypress(key: string): Promise<void>;
  scroll(direction: ScrollDirection, pixels?: number): Promise<void>;
  close(): Promise<void>;
}

interface ManagedBrowserSession {
  id: string;
  missionId: string;
  runtime: BrowserRuntime;
  state: BrowserState;
  references: Map<string, DesignReference>;
}

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = { width: 1200, height: 800, deviceScaleFactor: 1 };

export const VIEWPORT_PRESETS: { id: BrowserViewportMode; label: string; viewport?: BrowserViewport }[] = [
  { id: 'fit', label: 'Fit' },
  { id: 'desktop', label: 'Desktop', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } },
  { id: 'laptop', label: 'Laptop', viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } },
  { id: 'tablet', label: 'Tablet', viewport: { width: 820, height: 1180, deviceScaleFactor: 1 } },
  { id: 'mobile', label: 'Mobile', viewport: { width: 390, height: 844, deviceScaleFactor: 2 } },
  { id: 'custom', label: 'Custom' },
];

export class BrowserSessionManager {
  private readonly sessions = new Map<string, ManagedBrowserSession>();

  constructor(private readonly options: BrowserSessionManagerOptions = {}) {}

  async open(input: { missionId: string; url: string; viewport?: BrowserViewport; viewportMode?: BrowserViewportMode }): Promise<BrowserState> {
    const session = this.sessionFor(input.missionId, input.viewport, input.viewportMode);
    const snapshot = await session.runtime.open(input.url);
    session.state = await this.stateFromSnapshot(session, snapshot);
    this.emitUpdated(session.state);
    return session.state;
  }

  async refresh(missionId: string): Promise<BrowserState> {
    const session = this.requireSession(missionId);
    session.state = await this.stateFromSnapshot(session, await session.runtime.snapshot());
    this.emitUpdated(session.state);
    return session.state;
  }

  async resizeViewport(input: { missionId: string; viewport: BrowserViewport; viewportMode: BrowserViewportMode }): Promise<BrowserState> {
    const session = this.requireSession(input.missionId);
    session.state = { ...session.state, viewport: input.viewport, viewportMode: input.viewportMode };
    await session.runtime.setViewport(input.viewport);
    session.state = await this.stateFromSnapshot(session, await session.runtime.snapshot());
    this.emitUpdated(session.state);
    return session.state;
  }

  async click(input: { missionId: string; ref?: string; x?: number; y?: number }): Promise<BrowserState> {
    const session = this.requireSession(input.missionId);
    const point = input.ref ? centerOf(this.requireRef(session, input.ref)) : pointFrom(input);
    await session.runtime.click(point.x, point.y);
    return this.refresh(session.missionId);
  }

  async type(missionId: string, text: string): Promise<BrowserState> {
    const session = this.requireSession(missionId);
    await session.runtime.type(text);
    return this.refresh(session.missionId);
  }

  async keypress(missionId: string, key: string): Promise<BrowserState> {
    const session = this.requireSession(missionId);
    await session.runtime.keypress(key);
    return this.refresh(session.missionId);
  }

  async scroll(missionId: string, direction: ScrollDirection, pixels?: number): Promise<BrowserState> {
    const session = this.requireSession(missionId);
    await session.runtime.scroll(direction, pixels);
    return this.refresh(session.missionId);
  }

  async screenshot(missionId: string, fullPage = false): Promise<string> {
    const session = this.requireSession(missionId);
    const screenshotPath = await session.runtime.screenshot(fullPage);
    session.state = {
      ...session.state,
      screenshotPath,
      screenshotUrl: this.options.assetUrlFor?.(screenshotPath),
    };
    this.emitUpdated(session.state);
    return screenshotPath;
  }

  inspectPoint(missionId: string, x: number, y: number): BrowserElementRef | undefined {
    const session = this.requireSession(missionId);
    return session.state.refs.find((ref) =>
      x >= ref.box.x &&
      y >= ref.box.y &&
      x <= ref.box.x + ref.box.width &&
      y <= ref.box.y + ref.box.height,
    );
  }

  addReference(missionId: string, reference: Omit<DesignReference, 'id' | 'url' | 'title' | 'viewport' | 'scroll' | 'screenshotPath'> & { id?: string }): DesignReference {
    const session = this.requireSession(missionId);
    if (!session.state.screenshotPath) throw new Error('Capture a browser screenshot before adding a design reference.');
    const next: DesignReference = {
      ...reference,
      id: reference.id ?? `ref-${randomUUID()}`,
      url: session.state.url,
      title: session.state.title,
      viewport: session.state.viewport,
      scroll: session.state.scroll,
      screenshotPath: session.state.screenshotPath,
    };
    session.references.set(next.id, next);
    return next;
  }

  async designPrompt(input: { missionId: string; instruction: string; referenceIds: string[] }): Promise<{ path: string; prompt: string }> {
    const session = this.requireSession(input.missionId);
    const references = input.referenceIds.map((id) => session.references.get(id)).filter((ref): ref is DesignReference => Boolean(ref));
    if (references.length === 0) throw new Error('Select or sketch at least one browser reference before sending a Design Mode prompt.');
    const { path } = await (this.options.writePack ?? writeDesignPromptPack)({
      missionId: input.missionId,
      browserSessionId: session.id,
      instruction: input.instruction,
      references,
    });
    return { path, prompt: formatDesignPrompt(path, input.instruction, references) };
  }

  state(missionId: string): BrowserState | undefined {
    return this.resolveSession(missionId)?.state;
  }

  async close(missionId: string): Promise<void> {
    const session = this.resolveSession(missionId);
    if (!session) return;
    await session.runtime.close();
    this.sessions.delete(keyFor(missionId));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.runtime.close().catch(() => {})));
    this.sessions.clear();
  }

  private sessionFor(missionId: string, viewport = DEFAULT_BROWSER_VIEWPORT, viewportMode: BrowserViewportMode = 'fit'): ManagedBrowserSession {
    const key = keyFor(missionId);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.state = { ...existing.state, viewport, viewportMode };
      return existing;
    }
    const id = `browser-${missionId}-${Date.now().toString(36)}`;
    const runtime = this.options.runtimeFactory?.(id, viewport) ?? new MacChromeCdpRuntime({ sessionId: id, viewport });
    const session: ManagedBrowserSession = {
      id,
      missionId,
      runtime,
      references: new Map(),
      state: {
        sessionId: id,
        missionId,
        url: 'about:blank',
        viewport,
        viewportMode,
        scroll: { x: 0, y: 0 },
        refs: [],
      },
    };
    this.sessions.set(key, session);
    return session;
  }

  private requireSession(missionId: string): ManagedBrowserSession {
    const session = this.resolveSession(missionId);
    if (!session) throw new Error('Browser session is not open yet.');
    return session;
  }

  private resolveSession(missionId: string): ManagedBrowserSession | undefined {
    return this.sessions.get(keyFor(missionId));
  }

  private async stateFromSnapshot(
    session: ManagedBrowserSession,
    snapshot: { url: string; title?: string; scroll: { x: number; y: number }; refs: BrowserElementRef[] },
  ): Promise<BrowserState> {
    const screenshotPath = await session.runtime.screenshot(false);
    return {
      ...session.state,
      ...snapshot,
      screenshotPath,
      screenshotUrl: this.options.assetUrlFor?.(screenshotPath),
    };
  }

  private requireRef(session: ManagedBrowserSession, refId: string): BrowserElementRef {
    const ref = session.state.refs.find((item) => item.ref === refId);
    if (!ref) throw new Error(`Browser ref ${refId} is not available. Refresh the browser snapshot and try again.`);
    return ref;
  }

  private emitUpdated(state: BrowserState): void {
    this.options.emit?.({ type: 'browser.updated', state });
  }
}

function keyFor(missionId: string): string {
  return missionId;
}

function centerOf(ref: BrowserElementRef): { x: number; y: number } {
  return {
    x: Math.round(ref.box.x + ref.box.width / 2),
    y: Math.round(ref.box.y + ref.box.height / 2),
  };
}

function pointFrom(input: { x?: number; y?: number }): { x: number; y: number } {
  if (input.x === undefined || input.y === undefined) throw new Error('browser.click requires either a ref or x/y coordinates.');
  return { x: input.x, y: input.y };
}
