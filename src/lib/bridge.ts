import { getBridgeInfo } from './desktop';
import type { ClientCommand, ServerEvent } from '../types/bridge';

type Listener = (ev: ServerEvent) => void;

class Bridge {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private queue: ClientCommand[] = [];
  private backoff = 500;
  private url = '';
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { port, token } = await getBridgeInfo();
    this.url = `ws://127.0.0.1:${port}${token ? `?token=${token}` : ''}`;
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
      pending.forEach((c) => ws.send(JSON.stringify(c)));
    };
    ws.onmessage = (e) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(e.data) as ServerEvent;
      } catch {
        return;
      }
      this.listeners.forEach((l) => l(ev));
    };
    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    setTimeout(() => this.open(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5000);
  }

  send(cmd: ClientCommand): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
    else this.queue.push(cmd);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const bridge = new Bridge();
