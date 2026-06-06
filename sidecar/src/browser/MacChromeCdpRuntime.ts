import { mkdir, writeFile } from 'node:fs/promises';
import { get, request } from 'node:http';
import { join } from 'node:path';
import { CdpClient } from './CdpClient.js';
import { ChromeProcess, type ChromeProcessHandle } from './ChromeProcess.js';
import { browserScreenshotDir } from './browserPaths.js';
import { DOM_SNAPSHOT_SCRIPT, normalizeSnapshot } from './domSnapshot.js';
import type { BrowserScreenshotOptions, BrowserSnapshot, BrowserViewport, ScrollDirection } from './types.js';

interface RuntimeEvaluateResult {
  result?: {
    value?: unknown;
  };
}

interface CaptureScreenshotResult {
  data: string;
}

interface TargetInfo {
  webSocketDebuggerUrl?: string;
}

export interface CdpLike {
  connect(url: string): Promise<void>;
  send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  close(): void;
}

export interface MacChromeCdpRuntimeOptions {
  sessionId: string;
  viewport: BrowserViewport;
  screenshotDir?: string;
  chrome?: ChromeProcess;
  cdp?: CdpLike;
  createPageTarget?: (port: number) => Promise<string>;
  now?: () => number;
}

export class MacChromeCdpRuntime {
  private chromeHandle?: ChromeProcessHandle;
  private readonly cdp: CdpLike;
  private started = false;
  private viewport: BrowserViewport;

  constructor(private readonly options: MacChromeCdpRuntimeOptions) {
    this.viewport = options.viewport;
    this.cdp = options.cdp ?? new CdpClient();
    this.started = Boolean(options.cdp);
  }

  async open(url: string): Promise<BrowserSnapshot> {
    await this.ensureStarted();
    await this.setViewport(this.viewport);
    await this.cdp.send('Page.navigate', { url }, 15_000);
    await this.waitForReadyState();
    await this.waitForPaint();
    return this.snapshot();
  }

  async setViewport(viewport: BrowserViewport): Promise<void> {
    this.viewport = viewport;
    await this.ensureStarted();
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.width < 700,
    });
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<string> {
    await this.ensureStarted();
    const originalViewport = this.viewport;
    const captureScale = options.deviceScaleFactor ?? originalViewport.deviceScaleFactor;
    const shouldTemporarilyScale = captureScale !== originalViewport.deviceScaleFactor;
    if (shouldTemporarilyScale) {
      await this.setViewport({ ...originalViewport, deviceScaleFactor: captureScale });
    }
    try {
      const params = options.fullPage ? await this.fullPageScreenshotParams() : { format: 'png', fromSurface: true };
      const result = await this.cdp.send<CaptureScreenshotResult>('Page.captureScreenshot', params, 20_000);
      const dir = this.options.screenshotDir ?? browserScreenshotDir(this.options.sessionId);
      await mkdir(dir, { recursive: true });
      const path = join(dir, `shot-${this.options.now?.() ?? Date.now()}.png`);
      await writeFile(path, Buffer.from(result.data, 'base64'));
      return path;
    } finally {
      if (shouldTemporarilyScale) {
        await this.setViewport(originalViewport);
      }
    }
  }

  async snapshot(): Promise<BrowserSnapshot> {
    await this.ensureStarted();
    const result = await this.evaluate(DOM_SNAPSHOT_SCRIPT);
    return normalizeSnapshot(result);
  }

  async click(x: number, y: number): Promise<void> {
    await this.ensureStarted();
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await this.waitForInputSettled();
  }

  async type(text: string): Promise<void> {
    await this.ensureStarted();
    await this.cdp.send('Input.insertText', { text });
    await this.waitForPaint();
  }

  async keypress(key: string): Promise<void> {
    await this.ensureStarted();
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
    await this.waitForInputSettled();
  }

  async scroll(direction: ScrollDirection, pixels = 500): Promise<void> {
    await this.ensureStarted();
    const delta = scrollDelta(direction, pixels);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(this.viewport.width / 2), y: Math.round(this.viewport.height / 2), ...delta });
    await this.waitForPaint();
  }

  async close(): Promise<void> {
    this.cdp.close();
    await this.chromeHandle?.close();
    this.chromeHandle = undefined;
    this.started = false;
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    const chrome = this.options.chrome ?? new ChromeProcess({ sessionId: this.options.sessionId, viewport: this.viewport });
    this.chromeHandle = await chrome.launch();
    const pageWebSocketUrl = await (this.options.createPageTarget ?? createPageTarget)(this.chromeHandle.port);
    await this.cdp.connect(pageWebSocketUrl);
    await Promise.all([
      this.cdp.send('Page.enable'),
      this.cdp.send('Runtime.enable'),
      this.cdp.send('DOM.enable'),
      this.cdp.send('Accessibility.enable'),
    ]);
    this.started = true;
  }

  private async waitForReadyState(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const readyState = await this.evaluate('document.readyState');
      if (readyState === 'interactive' || readyState === 'complete') return;
      await sleep(100);
    }
  }

  private async waitForInputSettled(): Promise<void> {
    await sleep(80);
    await this.waitForReadyState(2_500);
    await this.waitForPaint();
  }

  private async waitForPaint(): Promise<void> {
    await this.evaluate(`
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })
    `);
  }

  private async evaluate(expression: string): Promise<unknown> {
    const result = await this.cdp.send<RuntimeEvaluateResult>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result?.value;
  }

  private async fullPageScreenshotParams(): Promise<Record<string, unknown>> {
    const metrics = await this.cdp.send<{ contentSize?: { width: number; height: number } }>('Page.getLayoutMetrics');
    const width = Math.ceil(metrics.contentSize?.width ?? this.viewport.width);
    const height = Math.ceil(metrics.contentSize?.height ?? this.viewport.height);
    return {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    };
  }
}

export async function createPageTarget(port: number): Promise<string> {
  const target = await httpJson<TargetInfo>(`http://127.0.0.1:${port}/json/new?about:blank`, 'PUT');
  if (!target.webSocketDebuggerUrl) throw new Error('Chrome did not create a page target with a websocket URL');
  return target.webSocketDebuggerUrl;
}

function httpJson<T>(url: string, method: 'GET' | 'PUT' = 'GET'): Promise<T> {
  return new Promise((resolveJson, reject) => {
    const client = method === 'GET' ? get : request;
    const req = client(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`Chrome HTTP ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolveJson(JSON.parse(body) as T);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function scrollDelta(direction: ScrollDirection, pixels: number): { deltaX: number; deltaY: number } {
  if (direction === 'left') return { deltaX: -pixels, deltaY: 0 };
  if (direction === 'right') return { deltaX: pixels, deltaY: 0 };
  if (direction === 'up') return { deltaX: 0, deltaY: -pixels };
  return { deltaX: 0, deltaY: pixels };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
