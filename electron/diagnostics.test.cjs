const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const {
  createDiagnostics,
  createReportId,
  loadOrCreateIdentity,
  normalizeDescription,
  scrubEvent,
} = require('./diagnostics.cjs');

test('diagnostics identity is stable pseudonymous local state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'droidex-diagnostics-'));
  const filePath = path.join(dir, 'diagnostics.json');
  const first = await loadOrCreateIdentity({
    filePath,
    randomUUID: () => '12345678-1234-1234-1234-123456789abc',
    fs: require('node:fs/promises'),
  });
  const second = await loadOrCreateIdentity({
    filePath,
    randomUUID: () => 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    fs: require('node:fs/promises'),
  });

  assert.deepEqual(first, { userId: 'USR-123456781234' });
  assert.deepEqual(second, first);
});

test('manual bug reports carry support ids without default PII', async () => {
  const events = [];
  const scope = {
    setUser: (user) => events.push(['user', user]),
    setTags: (tags) => events.push(['tags', tags]),
  };
  const diagnostics = createDiagnostics({
    app: { getPath: () => '/tmp/droidex-test', getVersion: () => '1.2.3', isPackaged: true },
    dsn: 'https://public@example.invalid/1',
    now: () => new Date('2026-08-03T12:00:00Z'),
    randomBytes: () => Buffer.from('a1b2c3', 'hex'),
    randomUUID: () => '12345678-1234-1234-1234-123456789abc',
    fs: {
      readFile: async () => JSON.stringify({ version: 1, userId: 'USR-123456781234' }),
      mkdir: async () => undefined,
      writeFile: async () => undefined,
    },
    sentry: {
      withScope: (callback) => callback(scope),
      captureMessage: (message, context) => {
        events.push(['message', message, context]);
        return 'event-123';
      },
    },
  });

  assert.deepEqual(await diagnostics.reportBug('  update button froze  '), {
    reportId: 'BUG-20260803-A1B2C3',
    userId: 'USR-123456781234',
    eventId: 'event-123',
  });
  assert.equal(
    events.some(([kind, value]) => kind === 'message' && value === 'update button froze'),
    true,
  );
});

test('diagnostic payloads remove requests, breadcrumbs, and user fields except id', () => {
  assert.deepEqual(
    scrubEvent({
      message: 'boom',
      request: { url: 'https://secret.example/?token=x' },
      breadcrumbs: [{ message: 'secret' }],
      user: { id: 'USR-1', email: 'person@example.com', ip_address: '127.0.0.1' },
    }),
    { message: 'boom', request: undefined, breadcrumbs: [], user: { id: 'USR-1' } },
  );
});

test('bug report inputs are bounded and report ids are sortable', () => {
  assert.equal(normalizeDescription('  broken button  '), 'broken button');
  assert.throws(() => normalizeDescription('bad'), /at least 5/);
  assert.equal(
    createReportId(new Date('2026-08-03T00:00:00Z'), () => Buffer.from('010203', 'hex')),
    'BUG-20260803-010203',
  );
});
