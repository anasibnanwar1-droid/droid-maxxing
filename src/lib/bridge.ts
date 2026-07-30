import { getBridgeInfo } from './desktop';
import type { ClientCommand, ServerEvent } from '../types/bridge';

type Listener = (ev: ServerEvent) => void;
type OpenListener = () => ClientCommand[] | Promise<ClientCommand[]>;
type ReconnectScheduler = (action: () => void, delayMs: number) => void;

export class Bridge {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private openListeners = new Set<OpenListener>();
  private queue: ClientCommand[] = [];
  private backoff = 500;
  private url = '';
  private started = false;
  private reconnectScheduled = false;

  constructor(
    private readonly schedule: ReconnectScheduler = (action, delayMs) => {
      window.setTimeout(action, delayMs);
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { port, token } = await getBridgeInfo();
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
      void this.handleOpen(ws);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let ev: ServerEvent;
      try {
        ev = JSON.parse(e.data) as ServerEvent;
      } catch {
        return;
      }
      this.listeners.forEach((listener) => {
        listener(ev);
      });
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    this.schedule(() => {
      this.reconnectScheduled = false;
      this.open();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5000);
  }

  private async handleOpen(ws: WebSocket): Promise<void> {
    if (this.ws !== ws) return;
    this.backoff = 500;
    if (this.openListeners.size === 0) {
      this.flushQueue(ws);
      return;
    }
    const handshakes = await Promise.allSettled(
      [...this.openListeners].map((listener) => Promise.resolve().then(listener)),
    );
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    for (const handshake of handshakes) {
      if (handshake.status !== 'fulfilled') continue;
      handshake.value.forEach((command) => {
        ws.send(JSON.stringify(command));
      });
    }
    this.flushQueue(ws);
  }

  private flushQueue(ws: WebSocket): void {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    const pending = this.queue;
    this.queue = [];
    pending.forEach((command) => {
      ws.send(JSON.stringify(command));
    });
  }

  send(cmd: ClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
    else this.queue.push(cmd);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  subscribeOpen(listener: OpenListener): () => void {
    this.openListeners.add(listener);
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      void Promise.resolve()
        .then(listener)
        .then((commands) => {
          if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
          commands.forEach((command) => {
            ws.send(JSON.stringify(command));
          });
        })
        .catch((error: unknown) => {
          console.error('[bridge] open listener failed:', error);
        });
    }
    return () => {
      this.openListeners.delete(listener);
    };
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const bridge = new Bridge();
