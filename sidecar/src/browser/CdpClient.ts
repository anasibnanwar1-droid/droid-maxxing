import WebSocket from 'ws';

export interface CdpResponse<T> {
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

export interface CdpSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: unknown[]) => void): this;
}

export type CdpSocketFactory = (url: string) => CdpSocket;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpClient {
  private socket?: CdpSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly createSocket: CdpSocketFactory = (url) => new WebSocket(url) as CdpSocket) {}

  async connect(url: string): Promise<void> {
    const socket = this.createSocket(url);
    this.socket = socket;
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
    socket.on('close', () => this.failAll(new Error('CDP websocket closed')));
    if (socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.on('open', () => resolveOpen());
      socket.on('error', (err) => rejectOpen(err instanceof Error ? err : new Error(String(err))));
    });
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP websocket is not connected'));
    }
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket?.send(JSON.stringify(payload));
    });
  }

  close(): void {
    this.socket?.close();
    this.failAll(new Error('CDP client closed'));
  }

  private handleMessage(data: unknown): void {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let parsed: CdpResponse<unknown>;
    try {
      parsed = JSON.parse(text) as CdpResponse<unknown>;
    } catch {
      return;
    }
    if (!parsed.id) return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    if (parsed.error) {
      pending.reject(new Error(`CDP ${pending.method} failed: ${parsed.error.message}`));
      return;
    }
    pending.resolve(parsed.result ?? {});
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}
