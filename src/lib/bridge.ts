import { getBridgeInfo } from './desktop';
import type { ClientCommand, ServerEvent } from '../types/bridge';

type Listener = (ev: ServerEvent) => void;
type OpenListener = () => ClientCommand[] | Promise<ClientCommand[]>;
type ReconnectScheduler = (action: () => void, delayMs: number) => void;

export class Bridge {
  private ws: WebSocket | null = null;
  private readyWs: WebSocket | null = null;
  private bootstrapWs: WebSocket | null = null;
  private bootstrapTail: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  private openListeners = new Set<OpenListener>();
  private queue: ClientCommand[] = [];
  private nextOpenQueue: { command: ClientCommand; excludedSocket: WebSocket | null }[] = [];
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
      this.handleOpen(ws);
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
      this.readyWs = null;
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

  private handleOpen(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.backoff = 500;
    if (this.openListeners.size === 0) {
      this.flushNextOpenQueue(ws);
      this.readyWs = ws;
      this.flushQueue(ws);
      return;
    }
    this.enqueueBootstrap(ws, async () => {
      const handshakes = await Promise.all(
        [...this.openListeners].map((listener) => Promise.resolve().then(listener)),
      );
      return handshakes.flat();
    });
  }

  private flushQueue(ws: WebSocket): void {
    if (this.ws !== ws || this.readyWs !== ws || ws.readyState !== WebSocket.OPEN) return;
    const pending = this.queue;
    this.queue = [];
    pending.forEach((command) => {
      ws.send(JSON.stringify(command));
    });
  }

  private flushNextOpenQueue(ws: WebSocket): void {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    const ready = this.nextOpenQueue.filter((pending) => pending.excludedSocket !== ws);
    this.nextOpenQueue = this.nextOpenQueue.filter((pending) => pending.excludedSocket === ws);
    ready.forEach(({ command }) => {
      ws.send(JSON.stringify(command));
    });
  }

  send(cmd: ClientCommand): void {
    const ws = this.ws;
    if (ws && this.readyWs === ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
      return;
    }
    this.queue.push(cmd);
  }

  sendOnNextOpen(cmd: ClientCommand): void {
    this.nextOpenQueue.push({ command: cmd, excludedSocket: this.ws });
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
      this.enqueueBootstrap(ws, listener);
    }
    return () => {
      this.openListeners.delete(listener);
    };
  }

  isOpen(): boolean {
    return this.ws !== null && this.readyWs === this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private enqueueBootstrap(ws: WebSocket, loadCommands: OpenListener): void {
    const previous = this.bootstrapWs === ws ? this.bootstrapTail : null;
    this.bootstrapWs = ws;
    this.readyWs = null;
    const current = (previous ?? Promise.resolve()).then(async () => {
      const commands = await loadCommands();
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      commands.forEach((command) => {
        ws.send(JSON.stringify(command));
      });
    });
    this.bootstrapTail = current;
    void current
      .then(() => {
        if (
          this.ws !== ws ||
          ws.readyState !== WebSocket.OPEN ||
          this.bootstrapWs !== ws ||
          this.bootstrapTail !== current
        ) {
          return;
        }
        this.bootstrapTail = null;
        this.flushNextOpenQueue(ws);
        this.readyWs = ws;
        this.flushQueue(ws);
      })
      .catch((error: unknown) => {
        console.error('[bridge] reconnect bootstrap failed:', error);
        if (this.ws === ws) ws.close();
      });
  }
}

export const bridge = new Bridge();
