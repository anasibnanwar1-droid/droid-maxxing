import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/**
 * The preview harness: a tiny local static server that serves generated design
 * artifacts (e.g. the brand-guidelines page) so canvas frames render them live.
 * Only registered ids are served, and each id is pinned to one absolute dir with
 * path-traversal protection — nothing outside a registered preview dir is exposed.
 */
export class PreviewServer {
  private server?: http.Server;
  private port = 0;
  private readonly registry = new Map<string, string>();

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((res, rej) => {
      server.once('error', rej);
      server.listen(0, '127.0.0.1', () => res());
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  /** Pin an id to an absolute directory and return the URL that serves it. */
  register(id: string, dir: string): string {
    this.registry.set(id, resolve(dir));
    return this.urlFor(id);
  }

  urlFor(id: string): string {
    return `http://127.0.0.1:${this.port}/${encodeURIComponent(id)}/`;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((res) => server.close(() => res()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
      const match = /^\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!match) {
        res.writeHead(404).end('not found');
        return;
      }
      const id = decodeURIComponent(match[1]);
      const rel = match[2] ? decodeURIComponent(match[2]) : 'index.html';
      const dir = this.registry.get(id);
      if (!dir) {
        res.writeHead(404).end('unknown preview');
        return;
      }
      const full = resolve(join(dir, rel));
      if (full !== dir && !full.startsWith(`${dir}${sep}`)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const info = await stat(full).catch(() => null);
      const target = info?.isDirectory() ? resolve(join(full, 'index.html')) : full;
      const finalInfo = info?.isDirectory() ? await stat(target).catch(() => null) : info;
      if (!finalInfo?.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(500).end('error');
    }
  }
}
