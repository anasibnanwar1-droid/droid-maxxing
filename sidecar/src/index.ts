import { WebSocketServer, type WebSocket } from 'ws';
import { MissionManager } from './MissionManager.js';
import type { ClientCommand, ServerEvent } from './protocol.js';

const PORT = Number(process.env.BRIDGE_PORT ?? 8765);
const TOKEN = process.env.BRIDGE_TOKEN ?? '';
const ALLOW_LOCAL_NO_TOKEN = process.env.BRIDGE_ALLOW_LOCAL_NO_TOKEN === '1';
const EXIT_ON_STDIN_CLOSE = process.env.BRIDGE_EXIT_ON_STDIN_CLOSE !== '0';
const HOST = '127.0.0.1';

const clients = new Set<WebSocket>();

function broadcast(event: ServerEvent): void {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

const manager = new MissionManager(broadcast);

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on('listening', () => {
  // Stdout line consumed by the Tauri supervisor to confirm readiness.
  process.stdout.write(`SIDECAR_READY ${PORT}\n`);
});

wss.on('connection', (ws, req) => {
  if (TOKEN && !ALLOW_LOCAL_NO_TOKEN) {
    const url = new URL(req.url ?? '', `http://${HOST}`);
    if (url.searchParams.get('token') !== TOKEN) {
      ws.close(1008, 'unauthorized');
      return;
    }
  }
  clients.add(ws);

  ws.on('message', async (raw) => {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(raw.toString()) as ClientCommand;
    } catch {
      ws.send(JSON.stringify({ type: 'mission.error', message: 'Invalid JSON command' } satisfies ServerEvent));
      return;
    }
    try {
      await manager.handle(cmd);
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: 'mission.error',
          message: err instanceof Error ? err.message : String(err),
        } satisfies ServerEvent),
      );
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

async function shutdown(): Promise<void> {
  await manager.shutdown();
  wss.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (EXIT_ON_STDIN_CLOSE) process.stdin.on('close', shutdown);
