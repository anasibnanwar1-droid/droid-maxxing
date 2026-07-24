const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  createTerminalManager,
  createTerminalSubscriptionRegistry,
  MAX_REPLAY_BYTES,
} = require('./terminal.cjs');

function fixture(options = {}) {
  const instances = [];
  const manager = createTerminalManager({
    platform: 'darwin',
    randomId: (() => {
      let id = 0;
      return () => `terminal-${++id}`;
    })(),
    fsp: options.fsp ?? {
      stat: async () => ({ isDirectory: () => true }),
      realpath: async (cwd) => `/real${cwd}`,
    },
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    exitRetentionMs: options.exitRetentionMs,
    resolveShell: () => ({ file: '/bin/zsh', args: ['-l'] }),
    buildEnv: () => ({ TERM: 'xterm-256color' }),
    loadPty: () => ({
      spawn(file, args, options) {
        let dataHandler = () => {};
        let exitHandler = () => {};
        const instance = {
          file,
          args,
          options,
          writes: [],
          resizes: [],
          killed: false,
          onData(handler) {
            dataHandler = handler;
          },
          onExit(handler) {
            exitHandler = handler;
          },
          write(data) {
            this.writes.push(data);
          },
          resize(cols, rows) {
            this.resizes.push([cols, rows]);
          },
          kill() {
            this.killed = true;
          },
          emitData(data) {
            dataHandler(data);
          },
          emitExit(exitCode = 0, signal = 0) {
            exitHandler({ exitCode, signal });
          },
        };
        instances.push(instance);
        return instance;
      },
    }),
  });
  return { manager, instances };
}

test('terminal subscription cycles retain one sender cleanup listener', () => {
  let unsubscribed = 0;
  const manager = {
    subscribe: () => () => {
      unsubscribed += 1;
    },
  };
  const registry = createTerminalSubscriptionRegistry(manager);
  const sender = new EventEmitter();
  sender.id = 1;
  sender.isDestroyed = () => false;
  sender.send = () => {};

  for (let index = 0; index < 20; index += 1) {
    registry.subscribe(sender, `terminal-${index}`);
    registry.unsubscribe(sender, `terminal-${index}`);
  }

  assert.equal(sender.listenerCount('destroyed'), 1);
  assert.equal(unsubscribed, 20);

  registry.subscribe(sender, 'terminal-active');
  sender.emit('destroyed');

  assert.equal(sender.listenerCount('destroyed'), 0);
  assert.equal(unsubscribed, 21);
});

test('terminal manager keeps a PTY alive until explicit kill', async () => {
  const { manager, instances } = fixture();
  const terminal = await manager.create({
    missionId: 'mission-1',
    cwd: '/repo',
    cols: 100,
    rows: 30,
  });
  assert.equal(terminal.cwd, '/real/repo');
  manager.write(terminal.id, 'echo test\r');
  manager.resize(terminal.id, 120, 40);
  assert.deepEqual(instances[0].writes, ['echo test\r']);
  assert.deepEqual(instances[0].resizes, [[120, 40]]);
  assert.equal(manager.list().length, 1);
  manager.kill(terminal.id);
  assert.equal(instances[0].killed, true);
  assert.equal(manager.list().length, 0);
});

test('terminal subscribers receive bounded replay and exit state', async () => {
  const { manager, instances } = fixture();
  const terminal = await manager.create({ missionId: 'mission-1', cwd: '/repo' });
  instances[0].emitData('x'.repeat(MAX_REPLAY_BYTES + 32));
  instances[0].emitExit(7, 0);
  const events = [];
  manager.subscribe(terminal.id, (event) => events.push(event));
  assert.equal(events[0].kind, 'replay');
  assert.equal(Buffer.byteLength(events[0].data), MAX_REPLAY_BYTES);
  assert.equal(events[0].truncated, true);
  assert.equal(events[1].kind, 'exit');
  assert.equal(events[1].exitCode, 7);
});

test('terminal manager enforces per-mission and global limits', async () => {
  const { manager } = fixture();
  for (let index = 0; index < 4; index += 1) {
    await manager.create({ missionId: 'mission-1', cwd: '/repo' });
  }
  await assert.rejects(manager.create({ missionId: 'mission-1', cwd: '/repo' }), /per mission/);
  for (let index = 0; index < 4; index += 1) {
    await manager.create({ missionId: 'mission-2', cwd: '/repo' });
  }
  await assert.rejects(manager.create({ missionId: 'mission-3', cwd: '/repo' }), /global/);
});

test('concurrent terminal creation cannot exceed the per-mission limit', async () => {
  let releaseValidation;
  const validationGate = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  const { manager } = fixture({
    fsp: {
      stat: async () => {
        await validationGate;
        return { isDirectory: () => true };
      },
      realpath: async (cwd) => `/real${cwd}`,
    },
  });
  const creations = Array.from({ length: 6 }, () =>
    manager.create({ missionId: 'mission-1', cwd: '/repo' }),
  );

  releaseValidation();
  const results = await Promise.allSettled(creations);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 4);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 2);
  assert.equal(manager.list().length, 4);
});

test('exited terminals are reclaimed after the retention window', async () => {
  const cleanups = [];
  const { manager, instances } = fixture({
    setTimeout: (callback) => {
      cleanups.push(callback);
      return { unref() {} };
    },
    clearTimeout: () => {},
    exitRetentionMs: 10,
  });
  const exited = [];
  for (let index = 0; index < 4; index += 1) {
    exited.push(await manager.create({ missionId: 'mission-1', cwd: '/repo' }));
    instances[index].emitExit();
  }

  await assert.rejects(manager.create({ missionId: 'mission-1', cwd: '/repo' }), /per mission/);

  for (const cleanup of cleanups) cleanup();
  assert.equal(manager.list().length, 0);
  await manager.create({ missionId: 'mission-1', cwd: '/repo' });
});

test('replay trimming preserves complete UTF-8 characters', async () => {
  const { manager, instances } = fixture();
  const terminal = await manager.create({ missionId: 'mission-1', cwd: '/repo' });
  instances[0].emitData(`🙂${'a'.repeat(MAX_REPLAY_BYTES - 2)}`);
  const events = [];

  manager.subscribe(terminal.id, (event) => events.push(event));

  assert.equal(events[0].kind, 'replay');
  assert.equal(events[0].data.startsWith('\uFFFD'), false);
  assert.equal(events[0].data, 'a'.repeat(MAX_REPLAY_BYTES - 2));
  assert.equal(events[0].droppedBytes, 4);
});

test('terminal manager releases capacity when node-pty fails to load', async () => {
  const manager = createTerminalManager({
    platform: 'darwin',
    randomId: (() => {
      let id = 0;
      return () => `failed-terminal-${++id}`;
    })(),
    fsp: {
      stat: async () => ({ isDirectory: () => true }),
      realpath: async (cwd) => cwd,
    },
    resolveShell: () => ({ file: '/bin/zsh', args: ['-l'] }),
    loadPty: () => {
      throw new Error('node-pty unavailable');
    },
  });

  for (let attempt = 0; attempt < 9; attempt += 1) {
    await assert.rejects(
      manager.create({ missionId: 'mission-1', cwd: '/repo' }),
      /node-pty unavailable/,
    );
  }
  assert.equal(manager.list().length, 0);
});
