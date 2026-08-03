import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SessionManager } from './SessionManager.js';
import type { ClientCommand, ServerEvent } from './protocol.js';
import { resolveBrowserAssetPath } from './browser/browserPaths.js';

const REQUESTED_PORT = bridgePort(process.env.BRIDGE_PORT ?? '0');
const TOKEN = requiredSecret('BRIDGE_TOKEN');
const ASSET_TOKEN = requiredSecret('BROWSER_ASSET_TOKEN');
const EXIT_ON_STDIN_CLOSE = process.env.BRIDGE_EXIT_ON_STDIN_CLOSE !== '0';
const HOST = '127.0.0.1';
let boundPort = REQUESTED_PORT;

const clients = new Set<WebSocket>();

function broadcast(event: ServerEvent): void {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function browserAssetUrl(filePath: string): string {
  const url = new URL(`http://${HOST}:${String(boundPort)}/browser-assets`);
  url.searchParams.set('path', filePath);
  url.searchParams.set('token', ASSET_TOKEN);
  return url.toString();
}

const manager = new SessionManager(broadcast, { assetUrlFor: browserAssetUrl });

const server = createServer((req, res) => {
  if (serveBrowserAsset(req, res)) return;
  res.writeHead(404).end('not found');
});

const wss = new WebSocketServer({ server });
let shuttingDown = false;

server.once('error', (error) => {
  console.error(`Sidecar bridge failed to listen: ${error.message}`);
  process.exit(1);
});

server.listen(REQUESTED_PORT, HOST, () => {
  const address = server.address();
  if (!address || typeof address === 'string') {
    console.error('Sidecar bridge did not expose a TCP address.');
    process.exit(1);
    return;
  }
  boundPort = address.port;
  // Stdout line consumed by the desktop supervisor to confirm readiness.
  process.stdout.write(`SIDECAR_READY ${String(boundPort)}\n`);
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '', `http://${HOST}`);
  if (url.searchParams.get('token') !== TOKEN) {
    ws.close(1008, 'unauthorized');
    return;
  }
  clients.add(ws);

  ws.on('message', (raw) => void handleMessage(ws, raw));

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

async function handleMessage(ws: WebSocket, raw: RawData): Promise<void> {
  let cmd: ClientCommand;
  try {
    cmd = JSON.parse(messageText(raw)) as ClientCommand;
  } catch {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Invalid JSON command',
      } satisfies ServerEvent),
    );
    return;
  }
  try {
    await manager.handle(cmd);
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      } satisfies ServerEvent),
    );
  }
}

function messageText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return Buffer.concat(raw).toString('utf8');
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(1), 5_000);
  forceExit.unref();
  wss.close();
  server.close();
  try {
    await manager.shutdown();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  clearTimeout(forceExit);
  process.exit();
}

function serveBrowserAsset(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? '/', `http://${HOST}:${String(boundPort)}`);
  if (url.pathname !== '/browser-assets') return false;
  if (url.searchParams.get('token') !== ASSET_TOKEN) {
    res.writeHead(401).end('unauthorized');
    return true;
  }
  const filePath = url.searchParams.get('path');
  if (!filePath) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  void resolveBrowserAssetPath(filePath)
    .then(async (resolvedPath) => {
      if (!resolvedPath) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const info = await stat(resolvedPath);
      if (!info.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': contentType(resolvedPath),
        'cache-control': 'no-store',
      });
      createReadStream(resolvedPath).pipe(res);
    })
    .catch(() => res.writeHead(404).end('not found'));
  return true;
}

function requiredSecret(name: 'BRIDGE_TOKEN' | 'BROWSER_ASSET_TOKEN'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function bridgePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`BRIDGE_PORT must be an integer from 0 to 65535; received ${value}.`);
  }
  return port;
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
if (EXIT_ON_STDIN_CLOSE) {
  process.stdin.resume();
  process.stdin.once('end', () => void shutdown());
  process.stdin.once('close', () => void shutdown());
}
