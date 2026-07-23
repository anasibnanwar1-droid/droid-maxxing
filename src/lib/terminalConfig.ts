// Pure, testable helpers that describe the configuration and bounds of the
// utility-pane terminal PTYs. The Electron host module (`electron/terminal.cjs`)
// is the runtime counterpart and reuses the same constant values; this module
// exists so the renderer (limits UI, validation messages, default-shell preview)
// and the unit tests can exercise the rules without spinning up node-pty or
// touching the filesystem.

export const MAX_TERMINALS_PER_MISSION = 4;
export const MAX_GLOBAL_TERMINALS = 8;
// 2 MiB cap on the rolling replay buffer that is handed to a late subscriber
// when it attaches to an already-running PTY.
export const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;
export const TERMINAL_TERM = 'xterm-256color';
export const TERMINAL_COLORTERM = 'truecolor';

export interface TerminalLimits {
  maxPerMission: number;
  maxGlobal: number;
  maxReplayBytes: number;
}

export const TERMINAL_LIMITS: TerminalLimits = {
  maxPerMission: MAX_TERMINALS_PER_MISSION,
  maxGlobal: MAX_GLOBAL_TERMINALS,
  maxReplayBytes: MAX_REPLAY_BYTES,
};

export interface ResolvedShell {
  file: string;
  args: string[];
}

export interface ValidateCwdOk {
  ok: true;
  cwd: string;
}
export interface ValidateCwdErr {
  ok: false;
  error: string;
}
export type ValidateCwdResult = ValidateCwdOk | ValidateCwdErr;

export interface FsStatLike {
  isDirectory: () => boolean;
}

// Minimal subset of `node:fs/promises` consumed by `validateCwd`. Kept as an
// interface so unit tests can pass a stub instead of touching the disk.
export interface FsPromisesLike {
  stat: (p: string) => Promise<FsStatLike>;
  realpath: (p: string) => Promise<string>;
}

// Resolve the default shell portably. $SHELL wins on POSIX (falling back to
// zsh on macOS, bash on Linux, both as login shells); on Windows we honour a
// SHELL hint that points at pwsh, otherwise use cmd.exe from COMSPEC.
export function defaultShell(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedShell {
  if (platform === 'win32') {
    const shellHint = typeof env.SHELL === 'string' ? env.SHELL : '';
    if (shellHint && /[\\/]pwsh(\.exe)?$/.test(shellHint)) {
      return { file: shellHint, args: ['-NoLogo'] };
    }
    const comspecRaw = typeof env.COMSPEC === 'string' ? env.COMSPEC : '';
    const comspec = comspecRaw.length > 0 ? comspecRaw : 'cmd.exe';
    return { file: comspec, args: [] };
  }
  const shellHintRaw = typeof env.SHELL === 'string' ? env.SHELL : '';
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  return { file: shellHintRaw.length > 0 ? shellHintRaw : fallback, args: ['-l'] };
}

// Build the environment passed to the spawned PTY: inherit the parent env and
// pin TERM/COLORTERM so shells emit 256-color + truecolor escapes regardless of
// what the surrounding terminal advertised.
export function buildPtyEnv(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // The platform argument is intentionally accepted so callers (and tests) can
  // pin the target OS without relying on the live `process.platform`. The
  // behaviour is currently identical on every platform; the parameter remains
  // as a forward-compatible seam.
  void platform;
  return {
    ...env,
    TERM: TERMINAL_TERM,
    COLORTERM: TERMINAL_COLORTERM,
  };
}

// Validate that a cwd is a non-empty path that exists and is a directory, and
// resolve it to its canonical realpath. The fs interface is injected so this
// function is unit-testable without touching the disk.
export async function validateCwd(input: unknown, fsp: FsPromisesLike): Promise<ValidateCwdResult> {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, error: 'cwd is required' };
  }
  let stats: FsStatLike;
  try {
    stats = await fsp.stat(input);
  } catch {
    return { ok: false, error: `cwd does not exist: ${input}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, error: `cwd is not a directory: ${input}` };
  }
  try {
    const real = await fsp.realpath(input);
    return { ok: true, cwd: real };
  } catch {
    return { ok: false, error: `cwd realpath failed: ${input}` };
  }
}

// Slice a rolling buffer to the most recent `maxBytes` and surface whether any
// earlier bytes were dropped. Used by the PTY host when replaying output to a
// late subscriber; kept here so the truncation rule is unit-testable.
export function selectForReplay(
  buffer: Uint8Array | string,
  maxBytes: number,
): { data: string; truncated: boolean; droppedBytes: number } {
  const bytes = typeof buffer === 'string' ? Buffer.from(buffer, 'utf8') : Buffer.from(buffer);
  const cap = Math.max(0, Math.floor(maxBytes));
  if (bytes.length <= cap) {
    return { data: bytes.toString('utf8'), truncated: false, droppedBytes: 0 };
  }
  const trimmed = bytes.subarray(bytes.length - cap);
  return { data: trimmed.toString('utf8'), truncated: true, droppedBytes: bytes.length - cap };
}

// Coerce a user-supplied dimension (cols or rows) to a positive finite integer,
// falling back to the supplied default when the value is missing, non-numeric,
// or out of range. Used by both the host module and the renderer when sizing
// the PTY before the first measurement arrives.
export function resolveDimension(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

// Factory for ID generators; the default uses Web Crypto / Node crypto. Keeping
// the generator injectable makes terminal IDs deterministic in tests.
export function makeIdGenerator(randomUuid: () => string): () => string {
  return () => randomUuid();
}
