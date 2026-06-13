import { spawn } from 'node:child_process';
import type { EnvironmentReport, InstallChannel } from './protocol.js';

export interface ShellCommand {
  command: string;
  args: string[];
  shell?: boolean;
}

// Prefer the official script when curl exists, then Homebrew, then npm.
export function pickInstallChannel(env: Pick<EnvironmentReport, 'availableChannels'>): InstallChannel | null {
  const order: InstallChannel[] = ['script', 'brew', 'npm'];
  return order.find((channel) => env.availableChannels.includes(channel)) ?? null;
}

export function buildInstallCommand(channel: InstallChannel): ShellCommand {
  switch (channel) {
    case 'script':
      // Download to a temp file first so a failed curl aborts before `sh`
      // runs; a piped `curl | sh` would swallow download errors and could
      // report a successful install with nothing installed.
      return {
        command: 'f="$(mktemp)" && curl -fsSL https://app.factory.ai/cli -o "$f" && sh "$f"; r=$?; rm -f "$f"; exit $r',
        args: [],
        shell: true,
      };
    case 'brew':
      return { command: 'brew', args: ['install', '--cask', 'droid'] };
    case 'npm':
      return { command: 'npm', args: ['install', '-g', '@factory/cli'] };
  }
}

// `droid update` self-detects the install method. When the CLI is missing we
// fall back to the channel installer.
export function buildUpdateCommand(channel: InstallChannel | undefined, droidPath: string, cliPresent: boolean): ShellCommand {
  if (cliPresent) return { command: droidPath, args: ['update'] };
  return buildInstallCommand(channel ?? 'script');
}

export type ProgressLine = { stream: 'stdout' | 'stderr'; line: string };

export function runStreaming(cmd: ShellCommand, onLine: (line: ProgressLine) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = cmd.shell
      ? spawn(cmd.command, { shell: true, env: process.env })
      : spawn(cmd.command, cmd.args, { env: process.env });

    const pump = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.length) onLine({ stream, line });
      }
    };

    child.stdout?.on('data', pump('stdout'));
    child.stderr?.on('data', pump('stderr'));
    child.on('error', (err) => {
      onLine({ stream: 'stderr', line: err instanceof Error ? err.message : String(err) });
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
}
