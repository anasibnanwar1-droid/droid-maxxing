import type { BrowserNativeRequest, BrowserNativeResult } from '../protocol.js';
import type { BrowserRuntime } from './BrowserSessionManager.js';
import type { BrowserScreenshotOptions, BrowserSnapshot, BrowserViewport, ScrollDirection } from './types.js';

export interface NativeBrowserRuntimeOptions {
  sessionId: string;
  missionId: string;
  viewport: BrowserViewport;
  request: (request: BrowserNativeRequest) => Promise<BrowserNativeResult>;
  nextRequestId?: () => string;
}

export class NativeBrowserRuntime implements BrowserRuntime {
  private viewport: BrowserViewport;

  constructor(private readonly options: NativeBrowserRuntimeOptions) {
    this.viewport = options.viewport;
  }

  async open(url: string): Promise<BrowserSnapshot> {
    return this.snapshotFrom(await this.send({ action: 'open', url }));
  }

  async setViewport(viewport: BrowserViewport): Promise<void> {
    this.viewport = viewport;
  }

  async screenshot(_options: BrowserScreenshotOptions = {}): Promise<string> {
    throw new Error('The live Droid Control browser does not capture screenshots yet. Use browser_snapshot for DOM refs and visible state.');
  }

  async snapshot(): Promise<BrowserSnapshot> {
    return this.snapshotFrom(await this.send({ action: 'snapshot' }));
  }

  async click(x: number, y: number): Promise<void> {
    await this.send({ action: 'click', x, y });
  }

  async type(text: string): Promise<void> {
    await this.send({ action: 'type', text });
  }

  async keypress(key: string): Promise<void> {
    await this.send({ action: 'keypress', key });
  }

  async scroll(direction: ScrollDirection, pixels?: number): Promise<void> {
    await this.send({ action: 'scroll', direction, pixels });
  }

  async close(): Promise<void> {
    await this.send({ action: 'close' }).catch(() => {});
  }

  private send(input: Omit<BrowserNativeRequest, 'requestId' | 'missionId' | 'sessionId' | 'viewport'>): Promise<BrowserNativeResult> {
    return this.options.request({
      requestId: this.options.nextRequestId?.() ?? `native-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      missionId: this.options.missionId,
      sessionId: this.options.sessionId,
      viewport: this.viewport,
      ...input,
    });
  }

  private snapshotFrom(result: BrowserNativeResult): BrowserSnapshot {
    if (!result.ok) throw new Error(result.error ?? 'Native browser action failed.');
    if (!result.snapshot) throw new Error('Native browser did not return a page snapshot.');
    return result.snapshot;
  }
}
