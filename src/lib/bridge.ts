import { getBridgeInfo } from './desktop';
import type { ClientCommand, ServerEvent } from '../types/bridge';

type Listener = (ev: ServerEvent) => void;

type ReconnectScheduler = (callback: () => void, delayMs: number) => void;

interface TurnBaselineAdopter {
  gitAdoptTurnBaseline: (dir: string, clientRef: string, appSessionId: string) => Promise<unknown>;
}

function canAdoptTurnBaseline(api: object): api is TurnBaselineAdopter {
  return 'gitAdoptTurnBaseline' in api && typeof api.gitAdoptTurnBaseline === 'function';
}

export class Bridge {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private queue: ClientCommand[] = [];
  private backoff = 500;
  private url = '';
  private started = false;

  constructor(
    private readonly loadBridgeInfo = getBridgeInfo,
    private readonly schedule: ReconnectScheduler = (callback, delayMs) => {
      setTimeout(callback, delayMs);
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.connect();
  }

  private async connect(): Promise<void> {
    let port: number;
    let token: string;
    try {
      ({ port, token } = await this.loadBridgeInfo());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.url = `ws://127.0.0.1:${String(port)}${token ? `?token=${token}` : ''}`;
    this.open();
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      const pending = this.queue;
      this.queue = [];
      pending.forEach((command) => {
        ws.send(JSON.stringify(command));
      });
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let ev: ServerEvent;
      try {
        ev = JSON.parse(e.data) as ServerEvent;
      } catch {
        return;
      }
      if (ev.type === 'session.created' && ev.session.cwd) {
        const api = globalThis.window.droidControl;
        if (api && canAdoptTurnBaseline(api)) {
          void api
            .gitAdoptTurnBaseline(ev.session.cwd, ev.clientRef, ev.session.appSessionId)
            .catch(() => {
              // Best effort: Review falls back to HEAD when no baseline exists.
            });
        }
      }
      this.listeners.forEach((listener) => {
        listener(ev);
      });
    };
    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    this.schedule(() => void this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5000);
  }

  send(cmd: ClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
    else this.queue.push(cmd);
  }

  sendIfConnected(cmd: ClientCommand): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(cmd));
    return true;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const bridge = new Bridge();
