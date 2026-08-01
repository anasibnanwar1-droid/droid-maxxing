import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

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
  private readonly registry = new Map<string, PreviewRegistration>();

  constructor(private readonly openFile: (path: string) => Readable = createReadStream) {}

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

  /** Pin an id to an explicit set of canonical files and return its base URL. */
  async register(id: string, dir: string, assetPaths: readonly string[]): Promise<string> {
    const root = await realpath(dir);
    const assets = new Map<string, string>();
    for (const assetPath of assetPaths) {
      const key = normalizeAssetPath(assetPath);
      const canonicalPath = await realpath(resolve(root, key));
      if (!isWithin(root, canonicalPath)) {
        throw new Error(`Preview asset is outside its registered root: ${assetPath}`);
      }
      const info = await stat(canonicalPath);
      if (!info.isFile()) throw new Error(`Preview asset is not a file: ${assetPath}`);
      assets.set(key, canonicalPath);
    }
    this.registry.set(id, { root, assets });
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
      const registration = this.registry.get(id);
      if (!registration) {
        res.writeHead(404).end('unknown preview');
        return;
      }

      let key: string;
      try {
        key = normalizeAssetPath(match[2] ? decodeURIComponent(match[2]) : 'index.html');
      } catch {
        res.writeHead(403).end('forbidden');
        return;
      }

      const registeredPath = registration.assets.get(key);
      if (!registeredPath) {
        res.writeHead(404).end('not found');
        return;
      }

      const target = await realpath(registeredPath).catch(() => null);
      if (target !== registeredPath || !isWithin(registration.root, target)) {
        res.writeHead(404).end('not found');
        return;
      }
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }

      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      await pipeline(this.openFile(target), res);
    } catch {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(500).end('error');
      }
    }
  }
}

interface PreviewRegistration {
  root: string;
  assets: Map<string, string>;
}

function normalizeAssetPath(assetPath: string): string {
  const normalized = assetPath.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (
    normalized === '' ||
    isAbsolute(normalized) ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid preview asset path: ${assetPath}`);
  }
  return normalized;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
