const assert = require('node:assert/strict');
const test = require('node:test');
const { createTerminalManager, MAX_REPLAY_BYTES } = require('./terminal.cjs');

function fixture() {
  const instances = [];
  const manager = createTerminalManager({
    platform: 'darwin',
    randomId: (() => {
      let id = 0;
      return () => `terminal-${++id}`;
    })(),
    fsp: {
      stat: async () => ({ isDirectory: () => true }),
      realpath: async (cwd) => `/real${cwd}`,
    },
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
