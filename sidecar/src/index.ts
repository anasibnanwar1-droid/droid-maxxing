import { WebSocketServer, type WebSocket } from 'ws';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { MissionManager } from './MissionManager.js';
import type { ClientCommand, ServerEvent } from './protocol.js';
import { isBrowserAssetPath } from './browser/browserPaths.js';

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

function browserAssetUrl(filePath: string): string {
  const url = new URL(`http://${HOST}:${PORT}/browser-assets`);
  url.searchParams.set('path', filePath);
  if (TOKEN) url.searchParams.set('token', TOKEN);
  return url.toString();
}

const manager = new MissionManager(broadcast, { assetUrlFor: browserAssetUrl });

const server = createServer((req, res) => {
  if (serveBrowserAsset(req, res)) return;
  res.writeHead(404).end('not found');
});

const wss = new WebSocketServer({ server });

server.listen(PORT, HOST, () => {
  // Stdout line consumed by the desktop supervisor to confirm readiness.
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
  server.close();
  process.exit(0);
}

function serveBrowserAsset(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  if (url.pathname !== '/browser-assets') return false;
  if (TOKEN && !ALLOW_LOCAL_NO_TOKEN && url.searchParams.get('token') !== TOKEN) {
    res.writeHead(401).end('unauthorized');
    return true;
  }
  const filePath = url.searchParams.get('path');
  if (!filePath || !isBrowserAssetPath(filePath)) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  void stat(filePath)
    .then((info) => {
      if (!info.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
      createReadStream(filePath).pipe(res);
    })
    .catch(() => res.writeHead(404).end('not found'));
  return true;
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (EXIT_ON_STDIN_CLOSE) process.stdin.on('close', shutdown);
