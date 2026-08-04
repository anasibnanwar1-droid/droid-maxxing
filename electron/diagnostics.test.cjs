const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const {
  createDiagnostics,
  createEventId,
  createReportId,
  createTechnicalDiagnostics,
  loadAutomaticDiagnosticsPreference,
  loadOrCreateIdentity,
  normalizeFeedbackReport,
  scrubEvent,
} = require('./diagnostics.cjs');

const identityFs = {
  readFile: async (filePath) => {
    if (filePath.endsWith('diagnostics-preferences.json')) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return JSON.stringify({ version: 1, userId: 'USR-123456781234' });
  },
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  unlink: async () => undefined,
  rename: async () => undefined,
};

function diagnosticsOptions(sentry, overrides = {}) {
  return {
    app: { getPath: () => '/tmp/droidex-test', getVersion: () => '1.2.3', isPackaged: true },
    dsn: 'https://public@example.invalid/1',
    now: () => new Date('2026-08-03T12:00:00Z'),
    randomBytes: () => Buffer.from('a1b2c3d4e5f6', 'hex'),
    eventRandomBytes: () => Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
    randomUUID: () => '12345678-1234-1234-1234-123456789abc',
    systemVersion: () => '15.6.0',
    versions: { electron: '38.0.0', chrome: '140.0.0', node: '22.18.0' },
    fs: identityFs,
    sentry,
    ...overrides,
  };
}

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

test('Sentry receives the stable pseudonymous profile identity before SDK integrations start', async () => {
  let initialization;
  const diagnostics = createDiagnostics(
    diagnosticsOptions({
      init: (options) => {
        initialization = options;
      },
    }),
  );

  assert.equal(await diagnostics.initialize(), true);
  assert.deepEqual(initialization.initialScope, {
    user: { id: 'USR-123456781234' },
  });
  assert.equal(initialization.release, 'droidex@1.2.3');
  assert.equal(initialization.environment, 'production');
  assert.equal(initialization.sendDefaultPii, false);
  assert.equal(initialization.tracesSampleRate, 0);
});

test('automatic diagnostics default on and disabling closes Sentry and resets local identity', async () => {
  const removed = [];
  let didClose = false;
  let initializationCount = 0;
  const diagnostics = createDiagnostics(
    diagnosticsOptions(
      {
        init: () => {
          initializationCount += 1;
        },
        close: async () => {
          didClose = true;
        },
      },
      {
        fs: {
          ...identityFs,
          unlink: async (filePath) => removed.push(filePath),
        },
      },
    ),
  );

  assert.deepEqual(
    await loadAutomaticDiagnosticsPreference({
      filePath: '/tmp/missing-preference.json',
      fs: {
        readFile: async () => {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        },
      },
    }),
    { enabled: true },
  );
  assert.equal(await diagnostics.initialize(), true);
  assert.deepEqual(await diagnostics.setAutomaticDiagnosticsEnabled(false), { enabled: false });
  assert.equal(didClose, true);
  assert.deepEqual(removed, ['/tmp/droidex-test/diagnostics.json']);
  assert.deepEqual(await diagnostics.setAutomaticDiagnosticsEnabled(true), { enabled: true });
  assert.equal(
    initializationCount,
    1,
    'preference changes must relaunch instead of reinitializing',
  );
});

test('invalid diagnostics preferences fail closed instead of silently opting back in', async () => {
  let didInitialize = false;
  const failures = [];
  const diagnostics = createDiagnostics(
    diagnosticsOptions(
      { init: () => (didInitialize = true) },
      {
        fs: {
          ...identityFs,
          readFile: async (filePath) =>
            filePath.endsWith('diagnostics-preferences.json') ? '{broken' : identityFs.readFile(),
        },
        logError: (message, error) => failures.push({ message, error }),
      },
    ),
  );

  assert.equal(await diagnostics.initialize(), false);
  assert.equal(didInitialize, false);
  assert.equal(failures.length, 1);
});

test('manual feedback uses a report-scoped identity while automatic diagnostics are disabled', async () => {
  const writes = [];
  const diagnostics = createDiagnostics(
    diagnosticsOptions(
      {},
      {
        fs: {
          ...identityFs,
          readFile: async (filePath) =>
            filePath.endsWith('diagnostics-preferences.json')
              ? JSON.stringify({ version: 1, enabled: false })
              : identityFs.readFile(),
          writeFile: async (filePath) => writes.push(filePath),
        },
        fetch: async () => ({ ok: true, status: 200 }),
      },
    ),
  );

  const receipt = await diagnostics.reportFeedback({
    category: 'other',
    description: 'Explicit report while opted out',
  });
  assert.match(receipt.userId, /^USR-[A-F0-9]{12}$/);
  assert.deepEqual(writes, []);
});

test('diagnostics initialization failure does not block app startup or start an anonymous session', async () => {
  const failures = [];
  let didInitialize = false;
  const diagnostics = createDiagnostics(
    diagnosticsOptions(
      { init: () => (didInitialize = true) },
      {
        fs: {
          readFile: async (filePath) => {
            if (filePath.endsWith('diagnostics-preferences.json')) {
              const error = new Error('missing preference');
              error.code = 'ENOENT';
              throw error;
            }
            throw new Error('missing');
          },
          mkdir: async () => undefined,
          writeFile: async () => {
            throw new Error('disk unavailable');
          },
        },
        logError: (message, error) => failures.push({ message, error }),
      },
    ),
  );

  assert.equal(await diagnostics.initialize(), false);
  assert.equal(didInitialize, false);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /initialization skipped/);
  assert.match(failures[0].error.message, /disk unavailable/);
});

test('manual feedback carries a report id and explicit technical diagnostics', async () => {
  const requests = [];
  const diagnostics = createDiagnostics(
    diagnosticsOptions(
      {},
      {
        fetch: async (url, request) => {
          requests.push({ url, request });
          return { ok: true, status: 200 };
        },
      },
    ),
  );

  assert.deepEqual(
    await diagnostics.reportFeedback({ category: 'bug', description: '  update button froze  ' }),
    {
      reportId: 'RPT-20260803-A1B2C3D4E5F6',
      userId: 'USR-123456781234',
      eventId: '00112233445566778899aabbccddeeff',
    },
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/1\/envelope\/\?sentry_version=7&sentry_key=public$/);
  assert.equal(requests[0].request.method, 'POST');
  assert.equal(requests[0].request.headers['Content-Type'], 'application/x-sentry-envelope');
  const envelopeBody =
    typeof requests[0].request.body === 'string'
      ? requests[0].request.body
      : Buffer.from(requests[0].request.body).toString('utf8');
  const event = JSON.parse(envelopeBody.split('\n')[2]);
  assert.equal(event.event_id, '00112233445566778899aabbccddeeff');
  assert.equal(event.message, 'update button froze');
  assert.equal(event.level, 'info');
  assert.deepEqual(event.tags, {
    report_kind: 'manual_feedback',
    report_id: 'RPT-20260803-A1B2C3D4E5F6',
    feedback_category: 'bug',
    installation_id: 'USR-123456781234',
    app_version: '1.2.3',
    platform: process.platform,
    arch: process.arch,
    os_version: '15.6.0',
    electron_version: '38.0.0',
    chrome_version: '140.0.0',
    node_version: '22.18.0',
    packaged: 'true',
  });
  assert.deepEqual(event.user, { id: 'USR-123456781234' });
  assert.equal(event.contexts, undefined);
  assert.equal(event.request, undefined);
});

test('manual feedback rejects non-2xx Sentry responses', async () => {
  for (const status of [429, 500]) {
    const diagnostics = createDiagnostics(
      diagnosticsOptions({}, { fetch: async () => ({ ok: false, status }) }),
    );
    await assert.rejects(
      () => diagnostics.reportFeedback({ category: 'other', description: 'Useful details' }),
      new RegExp(`rejected by Sentry \\(${String(status)}\\)`),
    );
  }
});

test('manual feedback retains retry state on network failure and timeout', async () => {
  const offline = createDiagnostics(
    diagnosticsOptions({}, { fetch: async () => Promise.reject(new Error('offline')) }),
  );
  await assert.rejects(
    () => offline.reportFeedback({ category: 'other', description: 'Useful details' }),
    /delivery failed/,
  );

  const timedOut = createDiagnostics(
    diagnosticsOptions(
      {},
      {
        deliveryTimeoutMs: 5,
        fetch: async (_url, request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      },
    ),
  );
  await assert.rejects(
    () => timedOut.reportFeedback({ category: 'other', description: 'Useful details' }),
    /delivery timed out/,
  );
});

test('crash payloads remove requests, breadcrumbs, and user fields except id', () => {
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

test('manual feedback payloads retain only explicitly disclosed fields', () => {
  const sanitized = scrubEvent({
    event_id: 'event-123',
    timestamp: 123,
    message: 'button froze',
    level: 'info',
    platform: 'javascript',
    release: 'droidex@1.2.3',
    environment: 'production',
    tags: {
      report_kind: 'manual_feedback',
      report_id: 'RPT-20260803-A1B2C3D4E5F6',
      feedback_category: 'bug',
      installation_id: 'USR-1',
      app_version: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
      os_version: '15.6.0',
      electron_version: '38.0.0',
      chrome_version: '140.0.0',
      node_version: '22.18.0',
      packaged: 'true',
      secret_tag: 'must disappear',
    },
    user: { id: 'USR-1', email: 'person@example.com' },
    request: { url: 'https://secret.example' },
    breadcrumbs: [{ message: 'private prompt' }],
    contexts: { browser: { url: 'https://private.example' } },
    extra: { projectPath: '/Users/person/secret-project' },
    modules: { privatePackage: '1.0.0' },
  });

  assert.deepEqual(Object.keys(sanitized).sort(), [
    'environment',
    'event_id',
    'level',
    'message',
    'platform',
    'release',
    'tags',
    'timestamp',
    'user',
  ]);
  assert.equal(sanitized.tags.secret_tag, undefined);
  assert.deepEqual(sanitized.user, { id: 'USR-1' });
  assert.equal(sanitized.contexts, undefined);
  assert.equal(sanitized.extra, undefined);
});

test('feedback inputs are closed, bounded, and report ids have 48 random bits', () => {
  assert.deepEqual(
    normalizeFeedbackReport({ category: 'good_result', description: '  nice work  ' }),
    {
      category: 'good_result',
      description: 'nice work',
    },
  );
  assert.throws(
    () => normalizeFeedbackReport({ category: 'unknown', description: 'Useful details' }),
    /category is invalid/,
  );
  assert.throws(
    () => normalizeFeedbackReport({ category: 'bug', description: 'bad' }),
    /at least 5/,
  );
  assert.equal(
    createReportId(new Date('2026-08-03T00:00:00Z'), () => Buffer.from('010203040506', 'hex')),
    'RPT-20260803-010203040506',
  );
  assert.equal(
    createEventId(() => Buffer.from('00112233445566778899aabbccddeeff', 'hex')),
    '00112233445566778899aabbccddeeff',
  );
});

test('technical diagnostics include only deterministic runtime facts', () => {
  assert.deepEqual(
    createTechnicalDiagnostics(
      diagnosticsOptions({}, { app: { getVersion: () => '2.0.0', isPackaged: false } }),
    ),
    {
      app_version: '2.0.0',
      platform: process.platform,
      arch: process.arch,
      os_version: '15.6.0',
      electron_version: '38.0.0',
      chrome_version: '140.0.0',
      node_version: '22.18.0',
      packaged: 'false',
    },
  );
});
