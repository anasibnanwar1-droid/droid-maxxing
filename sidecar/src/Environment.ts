import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { EnvironmentReport, InstallChannel, PackageManagers } from './protocol.js';

const execFileAsync = promisify(execFile);

// Shared resolution order so what onboarding reports as "installed" is exactly
// what DroidRuntime will spawn for login/update/session commands.
const CLI_CANDIDATES = [
  join(homedir(), '.factory', 'bin', 'droid'),
  join(homedir(), '.local', 'bin', 'droid'),
  '/opt/homebrew/bin/droid',
  '/usr/local/bin/droid',
];

// Synchronous, runtime-facing resolver. Returns the literal `droid` (resolved
// via PATH at spawn time) when no known location holds an executable.
export function resolveDroidPath(): string {
  // Only trust DROID_PATH when it points at a runnable binary; a stale override
  // must fall through to a real install instead of being spawned and failing.
  if (process.env.DROID_PATH && isExecutable(process.env.DROID_PATH)) return process.env.DROID_PATH;
  for (const candidate of CLI_CANDIDATES) {
    if (isExecutable(candidate)) return candidate;
  }
  // Resolve the real PATH entry (on Windows this is usually a `droid.cmd` shim)
  // so callers can spawn it correctly instead of a bare `droid`.
  return resolveOnPathSync('droid') ?? 'droid';
}

// Builds the spawn target for the daemon transport. The SDK's ProcessTransport
// spawns without a shell, and on Windows the npm-installed `droid` is a `.cmd`
// shim that can't be spawned directly, so route it through cmd.exe.
export function wrapDroidInvocation(
  droidPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { execPath: string; execArgs: string[] } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(droidPath)) {
    return { execPath: process.env.ComSpec || 'cmd.exe', execArgs: ['/c', droidPath, ...args] };
  }
  return { execPath: droidPath, execArgs: args };
}

export function buildDroidInvocation(args: string[]): { execPath: string; execArgs: string[] } {
  return wrapDroidInvocation(resolveDroidPath(), args);
}

function resolveOnPathSync(command: string): string | undefined {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((e) => e.trim())
      .filter(Boolean);
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, command + ext);
        if (existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

// Heuristic auth marker written by `droid login`.
const AUTH_FILE = join(homedir(), '.factory', 'auth.v2.file');

export async function detectEnvironment(apiKeyConfigured: boolean): Promise<EnvironmentReport> {
  const cliPath = await resolveCliPath();
  // Route a Windows .cmd/.bat shim through cmd.exe; execFile can't run it directly.
  const cliVersion = cliPath ? await probeCliVersion(cliPath) : undefined;
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

export function availableChannels(
  pm: PackageManagers,
  platform: NodeJS.Platform = process.platform,
): InstallChannel[] {
  const channels: InstallChannel[] = [];
  // The official installer is a POSIX shell script, so only offer it where a
  // `sh` pipeline can run. On Windows curl exists but `sh` usually does not.
  if (pm.curl && platform !== 'win32') channels.push('script');
  // The brew installer uses `--cask`, which only exists on macOS Homebrew;
  // Linuxbrew would fail deterministically.
  if (pm.brew && platform === 'darwin') channels.push('brew');
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
  if (process.env.DROID_PATH && isExecutable(process.env.DROID_PATH)) return process.env.DROID_PATH;
  for (const candidate of CLI_CANDIDATES) {
    if (isExecutable(candidate)) return candidate;
  }
  // A PATH hit is runnable by the runtime's `droid` fallback, so it stays
  // consistent with resolveDroidPath().
  const onPath = await commandPath('droid');
  return onPath && isExecutable(onPath) ? onPath : undefined;
}

// A path that exists but is not executable (broken/partial install) must not
// be reported as a present CLI. On Windows X_OK is not meaningful, so fall
// back to plain existence there.
function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  if (process.platform === 'win32') return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

function probeCliVersion(cliPath: string): Promise<string | undefined> {
  const { execPath, execArgs } = wrapDroidInvocation(cliPath, ['--version']);
  return commandVersion(execPath, execArgs);
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
