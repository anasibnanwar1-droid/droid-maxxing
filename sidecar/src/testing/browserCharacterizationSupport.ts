import type { BrowserSnapshot, BrowserState } from '../browser/types.js';
import type {
  BrowserNativeRequest,
  BrowserNativeResult,
  BrowserViewport,
  BrowserViewportMode,
  ServerEvent,
} from '../protocol.js';

export interface BrowserRecordedCall {
  target: 'browser' | 'cleanup';
  method: string;
  args: unknown[];
}

type BrowserEventEmitter = (event: Extract<ServerEvent, { type: 'browser.updated' }>) => void;

interface BrowserOpenInput {
  appSessionId: string;
  url: string;
  viewport?: BrowserViewport;
  viewportMode?: BrowserViewportMode;
}

const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = {
  width: 1200,
  height: 800,
  deviceScaleFactor: 2,
};

export class FakeBrowserSessionManager {
  readonly calls: BrowserRecordedCall[] = [];
  private readonly states = new Map<string, BrowserState>();

  constructor(
    private readonly record: (call: BrowserRecordedCall) => void,
    private readonly emit?: BrowserEventEmitter,
  ) {}

  open(input: BrowserOpenInput): Promise<void> {
    const existing = this.states.get(input.appSessionId);
    const state = browserState(
      input.appSessionId,
      input.url,
      input.viewport ?? existing?.viewport ?? DEFAULT_BROWSER_VIEWPORT,
      input.viewportMode ?? existing?.viewportMode ?? 'fit',
    );
    this.states.set(input.appSessionId, state);
    this.recordCall('browser', 'open', [input]);
    this.emit?.({ type: 'browser.updated', state });
    return Promise.resolve();
  }

  reload(appSessionId: string): Promise<void> {
    const state = this.requireOpenSession(appSessionId);
    this.recordCall('browser', 'reload', [appSessionId]);
    this.emit?.({ type: 'browser.updated', state });
    return Promise.resolve();
  }

  close(appSessionId: string): Promise<void> {
    this.states.delete(appSessionId);
    this.recordCall('cleanup', 'browser.close', [appSessionId]);
    return Promise.resolve();
  }

  closeAll(): Promise<void> {
    this.states.clear();
    this.recordCall('cleanup', 'browser.closeAll', []);
    return Promise.resolve();
  }

  private requireOpenSession(appSessionId: string): BrowserState {
    const state = this.states.get(appSessionId);
    if (!state) throw new Error('Browser session is not open yet.');
    return state;
  }

  private recordCall(target: BrowserRecordedCall['target'], method: string, args: unknown[]): void {
    const call = { target, method, args };
    this.calls.push(call);
    this.record(call);
  }
}

function browserState(
  appSessionId: string,
  url: string,
  viewport: BrowserViewport,
  viewportMode: BrowserViewportMode,
): BrowserState {
  return {
    browserSessionId: `browser-${appSessionId}`,
    appSessionId,
    url,
    viewport: { ...viewport },
    viewportMode,
    scroll: { x: 0, y: 0 },
    refs: [],
  };
}

export function nativeSnapshot(url: string): BrowserSnapshot {
  return {
    url,
    title: 'Example',
    scroll: { x: 0, y: 0 },
    refs: [],
    canGoBack: false,
    canGoForward: false,
  };
}

export function nativeSuccess(
  request: BrowserNativeRequest,
  snapshot = nativeSnapshot(request.url ?? 'about:blank'),
): BrowserNativeResult {
  return {
    requestId: request.requestId,
    appSessionId: request.appSessionId,
    ok: true,
    snapshot,
  };
}

type TimerCallback = (...args: unknown[]) => void;

interface NativeBrowserTimeout {
  timer?: ReturnType<typeof setTimeout>;
  callback: TimerCallback;
  args: unknown[];
  active: boolean;
}

export function observeNativeBrowserTimeouts() {
  const setTimeout = globalThis.setTimeout;
  const clearTimeout = globalThis.clearTimeout;
  const timeouts: NativeBrowserTimeout[] = [];

  Reflect.set(
    globalThis,
    'setTimeout',
    (callback: TimerCallback, delay?: number, ...args: unknown[]) => {
      const record: NativeBrowserTimeout = { callback, args, active: true };
      const timer = setTimeout(() => {
        record.active = false;
        callback(...args);
      }, delay);
      record.timer = timer;
      timeouts.push(record);
      return timer;
    },
  );
  Reflect.set(globalThis, 'clearTimeout', (timer: ReturnType<typeof setTimeout> | undefined) => {
    const record = timeouts.find((candidate) => candidate.timer === timer);
    if (record) record.active = false;
    clearTimeout(timer);
  });

  return {
    fireCurrent: () => {
      const record = timeouts.findLast((candidate) => candidate.active);
      if (!record) throw new Error('Missing native browser timeout.');
      record.active = false;
      clearTimeout(record.timer);
      record.callback(...record.args);
    },
    restore: () => {
      for (const record of timeouts) if (record.active) clearTimeout(record.timer);
      Reflect.set(globalThis, 'setTimeout', setTimeout);
      Reflect.set(globalThis, 'clearTimeout', clearTimeout);
    },
  };
}
