import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EnvironmentReport, InstallChannel, PackageManagers } from './protocol.js';

const execFileAsync = promisify(execFile);

const CLI_CANDIDATES = [
  process.env.DROID_PATH,
  join(homedir(), '.factory', 'bin', 'droid'),
  join(homedir(), '.local', 'bin', 'droid'),
  '/opt/homebrew/bin/droid',
  '/usr/local/bin/droid',
].filter((value): value is string => Boolean(value));

// Heuristic auth marker written by `droid login`.
const AUTH_FILE = join(homedir(), '.factory', 'auth.v2.file');

export async function detectEnvironment(apiKeyConfigured: boolean): Promise<EnvironmentReport> {
  const cliPath = await resolveCliPath();
  const cliVersion = cliPath ? await commandVersion(cliPath, ['--version']) : undefined;
  const packageManagers = await detectPackageManagers();

  return {
    platform: process.platform,
    arch: process.arch,
    osVersion: release(),
    node: { present: true, version: process.version.replace(/^v/, '') },
    cli: {
      present: Boolean(cliPath),
      path: cliPath ?? 'droid',
      version: cliVersion,
    },
    packageManagers,
    auth: {
      apiKeyConfigured,
      loginPresent: existsSync(AUTH_FILE),
    },
    availableChannels: availableChannels(packageManagers),
  };
}

export function availableChannels(pm: PackageManagers): InstallChannel[] {
  const channels: InstallChannel[] = [];
  if (pm.curl) channels.push('script');
  if (pm.brew) channels.push('brew');
  if (pm.npm) channels.push('npm');
  return channels;
}

// Returns negative when a < b, positive when a > b, 0 when equal. Tolerates
// missing/partial versions and ignores any pre-release/build suffix.
export function compareSemver(a: string | undefined, b: string | undefined): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parseSemver(value: string | undefined): [number, number, number] {
  const match = String(value ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

async function resolveCliPath(): Promise<string | undefined> {
  for (const candidate of CLI_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  const onPath = await commandPath('droid');
  return onPath ?? undefined;
}

async function detectPackageManagers(): Promise<PackageManagers> {
  const [brew, npm, curl, pnpm] = await Promise.all([
    commandExists('brew'),
    commandExists('npm'),
    commandExists('curl'),
    commandExists('pnpm'),
  ]);
  return { brew, npm, curl, pnpm };
}

async function commandExists(command: string): Promise<boolean> {
  return (await commandPath(command)) !== null;
}

async function commandPath(command: string): Promise<string | null> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(probe, [command], { timeout: 4000 });
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

async function commandVersion(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 8000, env: process.env });
    const match = stdout.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
