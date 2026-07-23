// Isolated PTY host for the utility-pane terminal. Owns every node-pty instance
// for the app and exposes a small manager API that `electron/main.cjs` wires to
// IPC channels. The module deliberately never imports Electron or renderer
// concerns: events are delivered to caller-provided subscriber callbacks, so
// the host can be unit-tested with mock PTYs and reused outside Electron.
//
// Lifecycle contract:
//   * PTYs are created on demand for a specific mission + cwd and stay alive
//     while the utility pane or chat is hidden — only an explicit `kill` /
//     `closeAll` (terminal tab close, app close) tears them down.
//   * Output is buffered in a rolling 2 MiB replay buffer with monotonic
//     sequence information so a late subscriber can render the recent past and
//     detect any dropped bytes.
//   * Up to 4 PTYs per mission and 8 across the whole app; IDs are random.
//
// The host takes dependency-injected pty/fs/os/crypto/random factories so the
// manager can be exercised without node-pty or the disk; the default singleton
// is constructed lazily on first use so `require('./terminal.cjs')` never
// throws when node-pty has not been installed yet.

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const MAX_TERMINALS_PER_MISSION = 4;
const MAX_GLOBAL_TERMINALS = 8;
const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERM = 'xterm-256color';
const COLORTERM = 'truecolor';

// Resolve the default shell portably. $SHELL wins on POSIX (falling back to
// zsh on macOS, bash on Linux, both as login shells); on Windows we honour a
// SHELL hint that points at pwsh, otherwise use cmd.exe from COMSPEC.
function defaultShell(platform, env) {
  const p = platform || process.platform;
  const e = env || process.env;
  if (p === 'win32') {
    const hint = typeof e.SHELL === 'string' ? e.SHELL : '';
    if (hint && /[\\/]pwsh(\.exe)?$/.test(hint)) return { file: hint, args: ['-NoLogo'] };
    const comspec = typeof e.COMSPEC === 'string' && e.COMSPEC.length > 0 ? e.COMSPEC : 'cmd.exe';
    return { file: comspec, args: [] };
  }
  const hint = typeof e.SHELL === 'string' && e.SHELL.length > 0 ? e.SHELL : '';
  const fallback = p === 'darwin' ? '/bin/zsh' : '/bin/bash';
  return { file: hint || fallback, args: ['-l'] };
}

// Build the environment for the spawned PTY: inherit the parent env and pin
// TERM/COLORTERM so shells always emit 256-color + truecolor escapes.
function buildPtyEnv(platform, env) {
  void platform;
  return { ...(env || process.env), TERM, COLORTERM };
}

// Validate that a cwd is a non-empty path that exists and is a directory, and
// resolve it to its canonical realpath. The fs interface is injected so this
// can be unit-tested without touching the disk.
async function validateCwd(input, fspApi) {
  const fspLib = fspApi || fsp;
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, error: 'cwd is required' };
  }
  let stats;
  try {
    stats = await fspLib.stat(input);
  } catch {
    return { ok: false, error: `cwd does not exist: ${input}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, error: `cwd is not a directory: ${input}` };
  }
  try {
    const real = await fspLib.realpath(input);
    return { ok: true, cwd: real };
  } catch {
    return { ok: false, error: `cwd realpath failed: ${input}` };
  }
}

function resolveDimension(value, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

function defaultRandomId() {
  // crypto.randomUUID exists on Node 14.17+ and is always available in the
  // Electron main process (Node 20+), but guard for the rare older runtime.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

// Build a manager. All side-effecting dependencies can be injected via `opts`
// so the manager can be tested without node-pty, the filesystem, or the OS.
function createTerminalManager(opts) {
  const config = opts || {};
  const platform = config.platform || process.platform;
  const idGen = config.randomId || defaultRandomId;
  const shellResolver = config.resolveShell || ((p, e) => defaultShell(p || platform, e));
  const envBuilder = config.buildEnv || ((p, e) => buildPtyEnv(p || platform, e));
  const fspLib = config.fsp || fsp;
  // Lazy-load node-pty only when the first PTY is spawned. require()ing this
  // module must never throw if node-pty has not been added to package.json.
  const loadPty =
    config.loadPty ||
    (() => {
      try {
        return require('node-pty');
      } catch {
        throw new Error(
          'node-pty is not installed. Add it to package.json dependencies before spawning terminals.',
        );
      }
    });

  // id -> entry
  const terminals = new Map();

  function countByMission(missionId) {
    let n = 0;
    for (const e of terminals.values()) {
      if (e.missionId === missionId) n += 1;
    }
    return n;
  }

  function makeEntry(id, missionId, cwd, file, args, dims) {
    return {
      id,
      missionId,
      cwd,
      shell: file,
      shellArgs: args,
      cols: dims.cols,
      rows: dims.rows,
      pty: null,
      buffer: Buffer.alloc(0), // rolling replay buffer (capped at MAX_REPLAY_BYTES)
      totalEmittedBytes: 0, // monotonic byte counter (never reset)
      droppedBytes: 0, // bytes trimmed from the front of the buffer
      sequence: 0, // monotonic event counter
      subscribers: new Set(), // (payload) => void, fired for replay/data/exit
      exitSubscribers: new Set(), // (payload) => void, fired once on exit
      exited: false,
      exitCode: null,
      signal: null,
      createdAt: Date.now(),
    };
  }

  async function create(args) {
    if (!args || typeof args !== 'object') {
      throw new Error('create() requires an options object');
    }
    const missionId = args.missionId;
    if (typeof missionId !== 'string' || missionId.length === 0) {
      throw new Error('missionId is required');
    }
    if (terminals.size >= MAX_GLOBAL_TERMINALS) {
      throw new Error(`Terminal limit reached (${MAX_GLOBAL_TERMINALS} global)`);
    }
    if (countByMission(missionId) >= MAX_TERMINALS_PER_MISSION) {
      throw new Error(`Mission terminal limit reached (${MAX_TERMINALS_PER_MISSION} per mission)`);
    }

    const cwdResult = await validateCwd(args.cwd, fspLib);
    if (!cwdResult.ok) throw new Error(cwdResult.error);

    const resolved = shellResolver(platform, args.env || process.env);
    const file =
      typeof args.shell === 'string' && args.shell.length > 0 ? args.shell : resolved.file;
    const fileArgs = Array.isArray(args.args) && args.args.length > 0 ? args.args : resolved.args;
    const finalEnv = envBuilder(platform, args.env || process.env);
    const dims = {
      cols: resolveDimension(args.cols, DEFAULT_COLS),
      rows: resolveDimension(args.rows, DEFAULT_ROWS),
    };

    const id = idGen();
    const entry = makeEntry(id, missionId, cwdResult.cwd, file, fileArgs, dims);
    // Register before spawn so an early exit still has somewhere to land.
    terminals.set(id, entry);

    let ptyInstance;
    try {
      const ptyLib = loadPty();
      ptyInstance = ptyLib.spawn(file, fileArgs, {
        name: TERM,
        cols: dims.cols,
        rows: dims.rows,
        cwd: cwdResult.cwd,
        env: finalEnv,
        // ConPTY is the modern Windows pseudoterminal; turning it on explicitly
        // matches node-pty's recommendation for new code.
        useConpty: platform === 'win32',
      });
    } catch (err) {
      terminals.delete(id);
      throw err;
    }

    entry.pty = ptyInstance;

    ptyInstance.onData((data) => {
      const buf = Buffer.from(data, 'utf8');
      entry.buffer = Buffer.concat([entry.buffer, buf]);
      entry.totalEmittedBytes += buf.length;
      if (entry.buffer.length > MAX_REPLAY_BYTES) {
        const excess = entry.buffer.length - MAX_REPLAY_BYTES;
        entry.buffer = entry.buffer.subarray(excess);
        entry.droppedBytes += excess;
      }
      entry.sequence += 1;
      const payload = {
        kind: 'data',
        data,
        sequence: entry.sequence,
        byteOffset: entry.totalEmittedBytes,
      };
      for (const cb of entry.subscribers) {
        try {
          cb(payload);
        } catch {
          // A throwing subscriber must never tear down the PTY loop.
        }
      }
    });

    ptyInstance.onExit(({ exitCode, signal }) => {
      entry.exited = true;
      entry.exitCode = typeof exitCode === 'number' ? exitCode : null;
      entry.signal = typeof signal === 'undefined' ? null : signal;
      entry.sequence += 1;
      const payload = {
        kind: 'exit',
        exitCode: entry.exitCode,
        signal: entry.signal,
        sequence: entry.sequence,
      };
      for (const cb of entry.subscribers) {
        try {
          cb(payload);
        } catch {
          // swallow subscriber errors
        }
      }
      for (const cb of entry.exitSubscribers) {
        try {
          cb(payload);
        } catch {
          // swallow subscriber errors
        }
      }
      // The entry stays in the map so summary() keeps working after an
      // unexpected exit; it is removed when kill()/closeAll() runs.
    });

    return {
      id,
      missionId,
      cwd: entry.cwd,
      shell: entry.shell,
      cols: entry.cols,
      rows: entry.rows,
    };
  }

  function requireEntry(id) {
    const e = terminals.get(id);
    if (!e) throw new Error(`Unknown terminal: ${id}`);
    return e;
  }

  function write(id, data) {
    const e = requireEntry(id);
    if (!e.pty) throw new Error(`Terminal ${id} has no pty`);
    if (e.exited) throw new Error(`Terminal ${id} has exited`);
    if (typeof data !== 'string') {
      throw new Error('write() data must be a string');
    }
    e.pty.write(data);
  }

  function resize(id, cols, rows) {
    const e = requireEntry(id);
    const c = resolveDimension(cols, e.cols);
    const r = resolveDimension(rows, e.rows);
    e.cols = c;
    e.rows = r;
    if (e.pty && typeof e.pty.resize === 'function' && !e.exited) {
      e.pty.resize(c, r);
    }
  }

  // Register a subscriber for `data`/`exit` events. The current replay buffer
  // is delivered immediately as a `replay` payload (with byte-offset and
  // truncation info), followed by a synthetic `exit` event if the PTY has
  // already exited. Returns an unsubscribe function. Safe to call multiple
  // times for the same id (one subscription per renderer pane).
  function subscribe(id, callback) {
    const e = requireEntry(id);
    if (typeof callback !== 'function') {
      throw new Error('subscribe() callback must be a function');
    }
    e.subscribers.add(callback);
    const replay = {
      kind: 'replay',
      data: e.buffer.toString('utf8'),
      byteOffset: e.totalEmittedBytes,
      droppedBytes: e.droppedBytes,
      totalEmittedBytes: e.totalEmittedBytes,
      truncated: e.droppedBytes > 0,
      sequence: e.sequence,
    };
    try {
      callback(replay);
    } catch {
      // swallow subscriber errors
    }
    if (e.exited) {
      const exitPayload = {
        kind: 'exit',
        exitCode: e.exitCode,
        signal: e.signal,
        sequence: e.sequence,
      };
      try {
        callback(exitPayload);
      } catch {
        // swallow subscriber errors
      }
    }
    return () => {
      e.subscribers.delete(callback);
    };
  }

  // Register a one-shot subscriber for the PTY's exit event. If the PTY has
  // already exited the callback fires synchronously. Returns an unsubscribe
  // function.
  function onExit(id, callback) {
    const e = requireEntry(id);
    if (typeof callback !== 'function') {
      throw new Error('onExit() callback must be a function');
    }
    if (e.exited) {
      try {
        callback({ exitCode: e.exitCode, signal: e.signal, sequence: e.sequence });
      } catch {
        // swallow subscriber errors
      }
      return () => {};
    }
    e.exitSubscribers.add(callback);
    return () => {
      e.exitSubscribers.delete(callback);
    };
  }

  // Kill a single PTY and remove its entry. Idempotent: a missing id is a
  // no-op. Clearing subscribers before kill() guarantees no exit event is
  // delivered to a renderer that has already torn down its listener.
  function kill(id) {
    const e = terminals.get(id);
    if (!e) return;
    e.subscribers.clear();
    e.exitSubscribers.clear();
    if (e.pty) {
      try {
        e.pty.kill();
      } catch {
        // The pty may already be dead; ignore ESRCH/EPERM.
      }
    }
    terminals.delete(id);
  }

  // Snapshot of the metadata for one terminal, without the pty handle.
  function summary(id) {
    const e = terminals.get(id);
    if (!e) return null;
    return {
      id: e.id,
      missionId: e.missionId,
      cwd: e.cwd,
      shell: e.shell,
      shellArgs: e.shellArgs,
      cols: e.cols,
      rows: e.rows,
      exited: e.exited,
      exitCode: e.exitCode,
      signal: e.signal,
      createdAt: e.createdAt,
      bufferedBytes: e.buffer.length,
      droppedBytes: e.droppedBytes,
      totalEmittedBytes: e.totalEmittedBytes,
      sequence: e.sequence,
    };
  }

  // Snapshot of all terminals (optionally filtered by missionId).
  function list(filter) {
    const out = [];
    for (const e of terminals.values()) {
      if (filter && filter.missionId && e.missionId !== filter.missionId) continue;
      out.push(summary(e.id));
    }
    return out;
  }

  // Kill every matching terminal. Idempotent. Returns the number closed.
  function closeAll(filter) {
    const ids = [];
    for (const e of terminals.values()) {
      if (filter && filter.missionId && e.missionId !== filter.missionId) continue;
      ids.push(e.id);
    }
    for (const id of ids) kill(id);
    return { closed: ids.length };
  }

  function limits() {
    return {
      maxPerMission: MAX_TERMINALS_PER_MISSION,
      maxGlobal: MAX_GLOBAL_TERMINALS,
      maxReplayBytes: MAX_REPLAY_BYTES,
    };
  }

  return {
    create,
    write,
    resize,
    subscribe,
    onExit,
    kill,
    summary,
    list,
    closeAll,
    limits,
  };
}

module.exports = {
  createTerminalManager,
  defaultShell,
  buildPtyEnv,
  validateCwd,
  defaultRandomId,
  MAX_TERMINALS_PER_MISSION,
  MAX_GLOBAL_TERMINALS,
  MAX_REPLAY_BYTES,
  DEFAULT_COLS,
  DEFAULT_ROWS,
};
