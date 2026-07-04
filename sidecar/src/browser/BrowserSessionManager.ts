import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserDesignReferenceDir } from './browserPaths.js';
import { normalizeBrowserUrl } from './browserUrl.js';
import { formatDesignPrompt, writeDesignPromptPack } from './designPromptPacks.js';
import type { DesignPromptContext } from './designPromptPacks.js';
import type { AuditElement } from '../design/types.js';
import type {
  BrowserBox,
  BrowserConsoleEvent,
  BrowserElementInspection,
  BrowserElementRef,
  BrowserNetworkEvent,
  BrowserScreenshotOptions,
  BrowserSnapshot,
  BrowserState,
  BrowserViewport,
  BrowserViewportMode,
  DesignAnchor,
  DesignAnchorDetail,
  DesignReference,
  DesignSelectionScreenshot,
  ScrollDirection,
} from './types.js';

export interface BrowserSessionManagerOptions {
  emit?: (
    event:
      | { type: 'browser.updated'; state: BrowserState }
      | { type: 'browser.error'; appSessionId?: string; message: string },
  ) => void;
  runtimeFactory?: (
    browserSessionId: string,
    viewport: BrowserViewport,
    appSessionId: string,
  ) => BrowserRuntime;
  assetUrlFor?: (path: string) => string;
  writePack?: typeof writeDesignPromptPack;
  browserDataDir?: string;
}

export interface BrowserRuntime {
  open(url: string): Promise<BrowserSnapshot>;
  reload(): Promise<BrowserSnapshot>;
  goBack(): Promise<BrowserSnapshot>;
  goForward(): Promise<BrowserSnapshot>;
  setViewport(viewport: BrowserViewport): Promise<void>;
  screenshot(options?: BrowserScreenshotOptions): Promise<string>;
  capture(box?: BrowserBox, options?: BrowserScreenshotOptions): Promise<string>;
  snapshot(): Promise<BrowserSnapshot>;
  click(x: number, y: number, selector?: string): Promise<BrowserSnapshot>;
  hover(x: number, y: number, selector?: string): Promise<BrowserSnapshot>;
  selectOption(selector: string, value: string): Promise<BrowserSnapshot>;
  type(text: string): Promise<BrowserSnapshot>;
  keypress(key: string): Promise<BrowserSnapshot>;
  scroll(
    direction: ScrollDirection,
    pixels?: number,
    x?: number,
    y?: number,
  ): Promise<BrowserSnapshot>;
  inspect(selector: string): Promise<BrowserElementInspection>;
  network(clear?: boolean): Promise<BrowserNetworkEvent[]>;
  console(clear?: boolean): Promise<BrowserConsoleEvent[]>;
  fillCredentials?(): Promise<BrowserSnapshot>;
  audit?(): Promise<AuditElement[]>;
  close(): Promise<void>;
}

interface ManagedBrowserSession {
  id: string;
  appSessionId: string;
  runtime: BrowserRuntime;
  state: BrowserState;
  references: Map<string, DesignReference>;
}

type BrowserInputSource = 'agent' | 'user';

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = {
  width: 1200,
  height: 800,
  deviceScaleFactor: 2,
};

export const VIEWPORT_PRESETS: {
  id: BrowserViewportMode;
  label: string;
  viewport?: BrowserViewport;
}[] = [
  { id: 'fit', label: 'Fit' },
  { id: 'desktop', label: 'Desktop', viewport: { width: 1440, height: 900, deviceScaleFactor: 2 } },
  { id: 'laptop', label: 'Laptop', viewport: { width: 1280, height: 800, deviceScaleFactor: 2 } },
  { id: 'tablet', label: 'Tablet', viewport: { width: 820, height: 1180, deviceScaleFactor: 2 } },
  { id: 'mobile', label: 'Mobile', viewport: { width: 390, height: 844, deviceScaleFactor: 2 } },
  { id: 'custom', label: 'Custom' },
];

export class BrowserSessionManager {
  private readonly sessions = new Map<string, ManagedBrowserSession>();

  constructor(private readonly options: BrowserSessionManagerOptions = {}) {}

  async open(input: {
    appSessionId: string;
    url: string;
    viewport?: BrowserViewport;
    viewportMode?: BrowserViewportMode;
  }): Promise<BrowserState> {
    const session = this.sessionFor(input.appSessionId, input.viewport, input.viewportMode);
    const url = normalizeBrowserUrl(input.url);
    if (input.viewport) {
      await session.runtime.setViewport(input.viewport);
    }
    session.state = {
      ...session.state,
      url,
      refs: [],
      canGoBack: false,
      canGoForward: false,
      viewport: input.viewport ?? session.state.viewport,
      viewportMode: input.viewportMode ?? session.state.viewportMode,
    };
    this.emitUpdated(session.state);
    const snapshot = await session.runtime.open(url);
    session.state = this.stateFromSnapshot(session, snapshot);
    this.emitUpdated(session.state);
    return session.state;
  }

  async reload(appSessionId: string): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    const snapshot = await session.runtime.reload();
    session.state = this.stateFromSnapshot(session, snapshot);
    this.emitUpdated(session.state);
    return session.state;
  }

  async goBack(appSessionId: string): Promise<BrowserState> {
    return this.navigateHistory(appSessionId, 'back');
  }

  async goForward(appSessionId: string): Promise<BrowserState> {
    return this.navigateHistory(appSessionId, 'forward');
  }

  async refresh(appSessionId: string): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    session.state = await this.captureState(session);
    this.emitUpdated(session.state);
    return session.state;
  }

  private async navigateHistory(
    appSessionId: string,
    direction: 'back' | 'forward',
  ): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    const snapshot =
      direction === 'back' ? await session.runtime.goBack() : await session.runtime.goForward();
    session.state = this.stateFromSnapshot(session, snapshot);
    this.emitUpdated(session.state);
    return session.state;
  }

  async resizeViewport(input: {
    appSessionId: string;
    viewport: BrowserViewport;
    viewportMode: BrowserViewportMode;
  }): Promise<BrowserState> {
    const session = this.requireSession(input.appSessionId);
    const nextState = {
      ...session.state,
      viewport: input.viewport,
      viewportMode: input.viewportMode,
      refs: [],
    };
    await session.runtime.setViewport(input.viewport);
    session.state = nextState;
    this.emitUpdated(session.state);
    return session.state;
  }

  async click(input: {
    appSessionId: string;
    ref?: string;
    x?: number;
    y?: number;
    source?: BrowserInputSource;
  }): Promise<BrowserState> {
    const session = this.requireSession(input.appSessionId);
    const target = input.ref ? this.requireRef(session, input.ref) : undefined;
    const point = target ? centerOf(target) : pointFrom(input);
    this.showAgentCursor(session, point, input.source);
    const snapshot = await session.runtime.click(point.x, point.y, target?.selector);
    return this.updateFromSnapshot(session, snapshot);
  }

  async hover(input: {
    appSessionId: string;
    ref?: string;
    x?: number;
    y?: number;
  }): Promise<BrowserState> {
    const session = this.requireSession(input.appSessionId);
    const target = input.ref ? this.requireRef(session, input.ref) : undefined;
    const point = target ? centerOf(target) : pointFrom(input);
    this.showAgentCursor(session, point, 'agent');
    const snapshot = await session.runtime.hover(point.x, point.y, target?.selector);
    return this.updateFromSnapshot(session, snapshot);
  }

  async selectOption(appSessionId: string, ref: string, value: string): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    const target = this.requireRef(session, ref);
    const snapshot = await session.runtime.selectOption(target.selector, value);
    return this.updateFromSnapshot(session, snapshot);
  }

  async wait(
    appSessionId: string,
    input: { text?: string; ref?: string; urlIncludes?: string; timeoutMs?: number },
  ): Promise<BrowserState> {
    const timeoutMs = Math.min(15_000, Math.max(0, input.timeoutMs ?? 5_000));
    if (!input.text && !input.ref && !input.urlIncludes) {
      await delay(timeoutMs);
      return this.refresh(appSessionId);
    }
    const deadline = Date.now() + timeoutMs;
    let state = await this.refresh(appSessionId);
    while (!waitConditionMatches(state, input) && Date.now() < deadline) {
      await delay(Math.min(200, Math.max(0, deadline - Date.now())));
      state = await this.refresh(appSessionId);
    }
    if (!waitConditionMatches(state, input)) {
      throw new Error('Timed out waiting for the browser condition.');
    }
    return state;
  }

  async type(appSessionId: string, text: string): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    const snapshot = await session.runtime.type(text);
    return this.updateFromSnapshot(session, snapshot);
  }

  async keypress(appSessionId: string, key: string): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    const snapshot = await session.runtime.keypress(key);
    return this.updateFromSnapshot(session, snapshot);
  }

  async scroll(
    appSessionId: string,
    direction: ScrollDirection,
    pixels?: number,
    source?: BrowserInputSource,
    ref?: string,
  ): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    const point = ref
      ? centerOf(this.requireRef(session, ref))
      : {
          x: Math.round(session.state.viewport.width / 2),
          y: Math.round(session.state.viewport.height / 2),
        };
    this.showAgentCursor(session, point, source);
    const snapshot = await session.runtime.scroll(direction, pixels, point.x, point.y);
    return this.updateFromSnapshot(session, snapshot);
  }

  async inspect(
    appSessionId: string,
    input: { ref?: string; selector?: string },
  ): Promise<BrowserElementInspection> {
    const session = this.requireSession(appSessionId);
    const selector = input.ref
      ? this.requireRef(session, input.ref).selector
      : input.selector?.trim();
    if (!selector) throw new Error('Browser inspection requires a ref or selector.');
    return session.runtime.inspect(selector);
  }

  async network(appSessionId: string, clear = false): Promise<BrowserNetworkEvent[]> {
    return this.requireSession(appSessionId).runtime.network(clear);
  }

  async console(appSessionId: string, clear = false): Promise<BrowserConsoleEvent[]> {
    return this.requireSession(appSessionId).runtime.console(clear);
  }

  async fillCredentials(appSessionId: string): Promise<BrowserState> {
    const session = this.requireSession(appSessionId);
    if (!session.runtime.fillCredentials) {
      throw new Error('Credential autofill is only available in the live Droid Control browser.');
    }
    const snapshot = await session.runtime.fillCredentials();
    session.state = this.stateFromSnapshot(session, snapshot);
    this.emitUpdated(session.state);
    return session.state;
  }

  async screenshot(appSessionId: string, options: BrowserScreenshotOptions = {}): Promise<string> {
    const session = this.requireSession(appSessionId);
    const base64 = await session.runtime.screenshot(options);
    const screenshotPath = await this.persistImage(
      appSessionId,
      `screenshot-${Date.now().toString(36)}.png`,
      base64,
    );
    session.state = {
      ...session.state,
      screenshotPath,
      screenshotUrl: this.options.assetUrlFor?.(screenshotPath),
    };
    this.emitUpdated(session.state);
    return screenshotPath;
  }

  inspectPoint(appSessionId: string, x: number, y: number): BrowserElementRef | undefined {
    const session = this.requireSession(appSessionId);
    return session.state.refs.find(
      (ref) =>
        x >= ref.box.x &&
        y >= ref.box.y &&
        x <= ref.box.x + ref.box.width &&
        y <= ref.box.y + ref.box.height,
    );
  }

  async addReference(
    appSessionId: string,
    input: { anchor: DesignAnchor; detail?: DesignAnchorDetail; id?: string },
    screenshot?: DesignSelectionScreenshot,
  ): Promise<DesignReference> {
    const session = this.requireSession(appSessionId);
    const id = input.id ?? input.anchor.id ?? `ref-${randomUUID()}`;
    const anchor: DesignAnchor = { ...input.anchor, id };
    const detail = input.detail ? { ...input.detail, id } : undefined;
    if (!anchor.screenshotPath) {
      const crop = await this.captureAnchorImage(session, anchor.box).catch(() => undefined);
      if (crop) anchor.screenshotPath = crop;
    }
    const next: DesignReference = {
      id,
      anchor,
      detail,
      url: session.state.url,
      title: session.state.title,
      viewport: session.state.viewport,
      scroll: session.state.scroll,
      screenshot,
      createdAt: new Date().toISOString(),
    };
    session.references.set(id, next);
    return next;
  }

  referenceDetail(appSessionId: string, id: string): DesignReference | undefined {
    return this.resolveSession(appSessionId)?.references.get(id);
  }

  async designPrompt(input: {
    appSessionId: string;
    instruction: string;
    referenceIds: string[];
    promptContext?: DesignPromptContext;
  }): Promise<{ path: string; prompt: string }> {
    const session = this.requireSession(input.appSessionId);
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error('Browser prompt cannot be empty.');
    const references = input.referenceIds
      .map((id) => session.references.get(id))
      .filter((ref): ref is DesignReference => Boolean(ref));
    if (references.length === 0)
      throw new Error(
        'Select or sketch at least one browser reference before sending a Design Mode prompt.',
      );
    const { path } = await (this.options.writePack ?? writeDesignPromptPack)({
      appSessionId: input.appSessionId,
      browserSessionId: session.id,
      instruction,
      references,
    });
    return { path, prompt: formatDesignPrompt(path, instruction, references, input.promptContext) };
  }

  async audit(appSessionId: string): Promise<AuditElement[]> {
    const session = this.requireSession(appSessionId);
    if (!session.runtime.audit) {
      throw new Error('This browser runtime does not support style audits.');
    }
    return session.runtime.audit();
  }

  state(appSessionId: string): BrowserState | undefined {
    return this.resolveSession(appSessionId)?.state;
  }

  designContext(appSessionId: string): { state: BrowserState; references: DesignReference[] } {
    const session = this.requireSession(appSessionId);
    return {
      state: session.state,
      references: [...session.references.values()],
    };
  }

  async close(appSessionId: string): Promise<void> {
    const session = this.resolveSession(appSessionId);
    if (!session) return;
    await session.runtime.close();
    this.sessions.delete(keyFor(appSessionId));
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) => session.runtime.close().catch(() => {})),
    );
    this.sessions.clear();
  }

  private sessionFor(
    appSessionId: string,
    viewport?: BrowserViewport,
    viewportMode?: BrowserViewportMode,
  ): ManagedBrowserSession {
    const key = keyFor(appSessionId);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.state = {
        ...existing.state,
        viewport: viewport ?? existing.state.viewport,
        viewportMode: viewportMode ?? existing.state.viewportMode,
      };
      return existing;
    }
    const initialViewport = viewport ?? DEFAULT_BROWSER_VIEWPORT;
    const initialViewportMode = viewportMode ?? 'fit';
    const id = `browser-${appSessionId}-${Date.now().toString(36)}`;
    const runtime = this.options.runtimeFactory?.(id, initialViewport, appSessionId);
    if (!runtime) {
      throw new Error('Browser runtime is not configured.');
    }
    const session: ManagedBrowserSession = {
      id,
      appSessionId,
      runtime,
      references: new Map(),
      state: {
        browserSessionId: id,
        appSessionId,
        url: 'about:blank',
        viewport: initialViewport,
        viewportMode: initialViewportMode,
        scroll: { x: 0, y: 0 },
        refs: [],
      },
    };
    this.sessions.set(key, session);
    return session;
  }

  private requireSession(appSessionId: string): ManagedBrowserSession {
    const session = this.resolveSession(appSessionId);
    if (!session) throw new Error('Browser session is not open yet.');
    return session;
  }

  private resolveSession(appSessionId: string): ManagedBrowserSession | undefined {
    return this.sessions.get(keyFor(appSessionId));
  }

  private stateFromSnapshot(
    session: ManagedBrowserSession,
    snapshot: BrowserSnapshot,
  ): BrowserState {
    return {
      ...session.state,
      ...snapshot,
    };
  }

  private async captureState(session: ManagedBrowserSession): Promise<BrowserState> {
    const snapshot = await session.runtime.snapshot();
    return {
      ...session.state,
      ...snapshot,
    };
  }

  private updateFromSnapshot(
    session: ManagedBrowserSession,
    snapshot: BrowserSnapshot,
  ): BrowserState {
    session.state = this.stateFromSnapshot(session, snapshot);
    this.emitUpdated(session.state);
    return session.state;
  }

  private requireRef(session: ManagedBrowserSession, refId: string): BrowserElementRef {
    const ref = session.state.refs.find((item) => item.ref === refId);
    if (!ref)
      throw new Error(
        `Browser ref ${refId} is not available. Refresh the browser snapshot and try again.`,
      );
    return ref;
  }

  private async captureAnchorImage(
    session: ManagedBrowserSession,
    box?: BrowserBox,
  ): Promise<string | undefined> {
    const base64 = await session.runtime.capture(box);
    if (!base64) return undefined;
    const tag = box ? `${box.x}-${box.y}-${box.width}-${box.height}` : 'view';
    return this.persistImage(
      session.appSessionId,
      `anchor-${tag}-${Date.now().toString(36)}.png`,
      base64,
    );
  }

  private async persistImage(appSessionId: string, name: string, base64: string): Promise<string> {
    const dir = browserDesignReferenceDir(appSessionId, this.options.browserDataDir);
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, Buffer.from(base64, 'base64'));
    return path;
  }

  private emitUpdated(state: BrowserState): void {
    this.options.emit?.({ type: 'browser.updated', state });
  }

  private showAgentCursor(
    session: ManagedBrowserSession,
    point: { x: number; y: number },
    source: BrowserInputSource = 'agent',
  ): void {
    if (source === 'user') return;
    session.state = { ...session.state, agentCursor: point };
    this.emitUpdated(session.state);
  }
}

function keyFor(appSessionId: string): string {
  return appSessionId;
}

function centerOf(ref: BrowserElementRef): { x: number; y: number } {
  return {
    x: Math.round(ref.box.x + ref.box.width / 2),
    y: Math.round(ref.box.y + ref.box.height / 2),
  };
}

function pointFrom(input: { x?: number; y?: number }): { x: number; y: number } {
  if (input.x === undefined || input.y === undefined)
    throw new Error('Browser interaction requires either a ref or x/y coordinates.');
  return { x: input.x, y: input.y };
}

function waitConditionMatches(
  state: BrowserState,
  input: { text?: string; ref?: string; urlIncludes?: string },
): boolean {
  if (input.urlIncludes && !state.url.includes(input.urlIncludes)) return false;
  if (input.ref && !state.refs.some((item) => item.ref === input.ref)) return false;
  if (input.text) {
    const expected = input.text.toLocaleLowerCase();
    if (
      !state.refs.some(
        (item) =>
          item.text?.toLocaleLowerCase().includes(expected) ||
          item.name?.toLocaleLowerCase().includes(expected),
      )
    )
      return false;
  }
  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
