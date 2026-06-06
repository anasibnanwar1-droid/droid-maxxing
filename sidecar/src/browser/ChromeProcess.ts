import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { browserProfileDir, resolveChromePath } from './browserPaths.js';
import type { BrowserViewport } from './types.js';

export interface ChromeVersionInfo {
  webSocketDebuggerUrl: string;
}

export interface ChromeProcessHandle {
  port: number;
  version: ChromeVersionInfo;
  close: () => Promise<void>;
}

export type ManagedChromeProcess = Pick<ChildProcess, 'kill' | 'killed' | 'once'>;
export type SpawnChrome = (command: string, args: string[]) => ManagedChromeProcess;
export type ReadChromeVersion = (port: number) => Promise<ChromeVersionInfo>;

export interface ChromeProcessOptions {
  sessionId: string;
  viewport: BrowserViewport;
  chromePath?: string;
  profileDir?: string;
  port?: number;
  spawnChrome?: SpawnChrome;
  readVersion?: ReadChromeVersion;
  readinessTimeoutMs?: number;
}

export class ChromeProcess {
  constructor(private readonly options: ChromeProcessOptions) {}

  async launch(): Promise<ChromeProcessHandle> {
    const chromePath = resolveChromePath(this.options.chromePath);
    const port = this.options.port ?? await allocateLocalPort();
    const profileDir = this.options.profileDir ?? browserProfileDir(this.options.sessionId);
    await mkdir(profileDir, { recursive: true });
    const args = chromeLaunchArgs({ port, profileDir, viewport: this.options.viewport });
    const child = (this.options.spawnChrome ?? defaultSpawnChrome)(chromePath, args);
    const version = await withTimeout(
      (this.options.readVersion ?? readChromeVersion)(port),
      this.options.readinessTimeoutMs ?? 8_000,
      'Chrome CDP readiness',
    );
    return {
      port,
      version,
      close: () => closeChrome(child),
    };
  }
}

export function chromeLaunchArgs(input: { port: number; profileDir: string; viewport: BrowserViewport }): string[] {
  const { port, profileDir, viewport } = input;
  return [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${viewport.width},${viewport.height}`,
    'about:blank',
  ];
}

export async function allocateLocalPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a local browser port')));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
    server.on('error', reject);
  });
}

async function readChromeVersion(port: number): Promise<ChromeVersionInfo> {
  const deadline = Date.now() + 8_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const payload = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
      const webSocketDebuggerUrl = stringField(payload, 'webSocketDebuggerUrl');
      if (webSocketDebuggerUrl) return { webSocketDebuggerUrl };
      lastError = new Error('Chrome CDP did not return webSocketDebuggerUrl');
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw new Error(`Chrome CDP did not become ready: ${errMsg(lastError)}`);
}

function httpGetJson(url: string): Promise<unknown> {
  return new Promise((resolveJson, reject) => {
    get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        try {
          resolveJson(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function defaultSpawnChrome(command: string, args: string[]): ManagedChromeProcess {
  return spawn(command, args, { stdio: 'ignore' });
}

async function closeChrome(child: ManagedChromeProcess): Promise<void> {
  if (child.killed) return;
  await new Promise<void>((resolveClose) => {
    const timer = setTimeout(() => resolveClose(), 1_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveClose();
    });
    child.kill('SIGTERM');
  });
}

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = (value as Record<string, unknown>)[field];
  return typeof item === 'string' ? item : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
