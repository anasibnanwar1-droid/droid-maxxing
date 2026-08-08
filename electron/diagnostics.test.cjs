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
  filterBreadcrumb,
  normalizeAttachmentData,
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

function acceptedResponse(eventId = '00112233445566778899aabbccddeeff') {
  return { ok: true, status: 200, json: async () => ({ id: eventId }) };
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
  assert.equal(initialization.maxBreadcrumbs, 50);
  assert.deepEqual(initialization.beforeBreadcrumb({ category: 'session', message: 'x' }), {
    category: 'session',
    message: 'x',
  });
  assert.equal(initialization.beforeBreadcrumb({ category: 'console', message: 'y' }), null);
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
    2,
    're-enabling diagnostics must initialize a fresh in-process client',
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
        fetch: async () => acceptedResponse(),
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
          return acceptedResponse();
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
  assert.equal(event.level, 'error');
  assert.deepEqual(event.exception, {
    values: [
      {
        type: 'UserSubmittedReport',
        value: 'update button froze',
        mechanism: { type: 'droidex.feedback', handled: true },
      },
    ],
  });
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

test('manual feedback requires Sentry to acknowledge the submitted event id', async () => {
  for (const response of [
    { ok: true, status: 200, json: async () => ({}) },
    { ok: true, status: 200, json: async () => ({ id: 'ffeeddccbbaa99887766554433221100' }) },
    { ok: true, status: 200, json: async () => Promise.reject(new Error('invalid json')) },
  ]) {
    const diagnostics = createDiagnostics(diagnosticsOptions({}, { fetch: async () => response }));
    await assert.rejects(
      () => diagnostics.reportFeedback({ category: 'bug', description: 'Useful details' }),
      /did not acknowledge this report/,
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

test('crash payloads remove requests and user fields except id, keep filtered breadcrumbs', () => {
  assert.deepEqual(
    scrubEvent({
      message: 'boom',
      request: { url: 'https://secret.example/?token=x' },
      breadcrumbs: [
        { message: 'secret' },
        { category: 'session', message: 'mode changed to spec' },
        { category: 'console', message: 'leaked log' },
      ],
      user: { id: 'USR-1', email: 'person@example.com', ip_address: '127.0.0.1' },
    }),
    {
      message: 'boom',
      request: undefined,
      breadcrumbs: [{ category: 'session', message: 'mode changed to spec' }],
      user: { id: 'USR-1' },
    },
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

test('breadcrumb filter allows all operational categories and drops everything else', () => {
  for (const category of ['app', 'session', 'bridge', 'navigation']) {
    const result = filterBreadcrumb({ category, message: 'test' });
    assert.equal(result?.category, category, `${category} should pass filter`);
  }
  assert.deepEqual(filterBreadcrumb({ category: 'app', message: 'focused', type: 'default' }), {
    category: 'app',
    message: 'focused',
    type: 'default',
  });
  assert.equal(filterBreadcrumb({ category: 'console', message: 'log stuff' }), null);
  assert.equal(filterBreadcrumb({ category: 'fetch', message: 'GET /api' }), null);
  assert.equal(filterBreadcrumb({ category: '', message: 'empty' }), null);
  assert.equal(filterBreadcrumb({ message: 'no category' }), null);
  assert.equal(filterBreadcrumb(null), null);
});

test('normalizeAttachmentData caps session log, sanitizes fields, and filters appState', () => {
  const longLog = Array.from({ length: 100 }, (_, i) => ({
    category: 'session',
    message: `entry ${i}`,
    level: 'info',
    timestamp: Date.now() + i,
  }));
  const result = normalizeAttachmentData({ sessionLog: longLog });
  assert.equal(result.sessionLog.length, 50);
  assert.equal(result.sessionLog[0].message, 'entry 50');
  assert.equal(result.sessionLog[49].message, 'entry 99');

  const messy = normalizeAttachmentData({
    sessionLog: [
      { category: 'a'.repeat(100), message: 'ok', level: 'invalid', timestamp: 'not-a-number' },
      { category: 'good', message: 'fine', level: 'warning', timestamp: 123 },
      null,
      'not an object',
    ],
  });
  assert.equal(messy.sessionLog.length, 2);
  assert.equal(messy.sessionLog[0].category.length, 64);
  assert.equal(messy.sessionLog[0].level, 'info');
  assert.deepEqual(messy.sessionLog[1], {
    category: 'good',
    message: 'fine',
    level: 'warning',
    timestamp: 123,
  });

  // appState field-level allowlist: unknown keys are dropped
  const withAppState = normalizeAttachmentData({
    appState: {
      interactionMode: 'spec',
      autonomy: 'high',
      activeSessionCount: 3,
      view: 'chat',
      secretKey: 'must disappear',
      cwd: '/Users/person/secret',
    },
  });
  assert.deepEqual(withAppState.appState, {
    interactionMode: 'spec',
    autonomy: 'high',
    activeSessionCount: 3,
    view: 'chat',
  });

  // Non-object appState is dropped
  const badAppState = normalizeAttachmentData({ appState: 'not-an-object' });
  assert.deepEqual(badAppState, {});
});

test('manual feedback with attachments delivers session log and app state in envelope', async () => {
  const requests = [];
  const diagnostics = createDiagnostics(
    diagnosticsOptions(
      {},
      {
        fetch: async (url, request) => {
          requests.push({ url, request });
          return acceptedResponse();
        },
      },
    ),
  );

  await diagnostics.reportFeedback({
    category: 'bug',
    description: 'crashed on mode switch',
    attachmentData: {
      sessionLog: [
        {
          category: 'session',
          message: 'mode changed to spec',
          level: 'info',
          timestamp: 1720000000000,
        },
      ],
      appState: { interactionMode: 'spec', autonomy: 'high', activeSessionCount: 2 },
    },
  });

  assert.equal(requests.length, 1);
  const envelopeBody =
    typeof requests[0].request.body === 'string'
      ? requests[0].request.body
      : Buffer.from(requests[0].request.body).toString('utf8');
  const lines = envelopeBody.split('\n');
  const event = JSON.parse(lines[2]);
  assert.deepEqual(event.extra.session_log, [
    {
      category: 'session',
      message: 'mode changed to spec',
      level: 'info',
      timestamp: 1720000000000,
    },
  ]);
  assert.deepEqual(event.contexts.app_state, {
    interactionMode: 'spec',
    autonomy: 'high',
    activeSessionCount: 2,
  });
});

test('manual feedback with screenshot attaches raw PNG bytes to envelope', async () => {
  const requests = [];
  const diagnostics = createDiagnostics(
    diagnosticsOptions(
      {},
      {
        fetch: async (url, request) => {
          requests.push({ url, request });
          return acceptedResponse();
        },
      },
    ),
  );

  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await diagnostics.reportFeedback(
    { category: 'bug', description: 'visual glitch on sidebar' },
    { screenshotPng: fakePng },
  );

  assert.equal(requests.length, 1);
  const rawBody = requests[0].request.body;
  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);

  // Envelope text portion ends with \n, then raw PNG bytes follow
  const textEnd = bodyBuffer.length - fakePng.length;
  const textPortion = bodyBuffer.subarray(0, textEnd).toString('utf8');
  const lines = textPortion.split('\n');
  // lines: [envHeaders, eventItemHeaders, eventPayload, attachmentHeaders, '']
  const attachmentHeader = JSON.parse(lines[3]);
  assert.equal(attachmentHeader.type, 'attachment');
  assert.equal(attachmentHeader.filename, 'screenshot.png');
  assert.equal(attachmentHeader.content_type, 'image/png');
  assert.equal(attachmentHeader.length, fakePng.length);

  // Verify raw bytes at end of body match fakePng exactly
  assert.deepEqual(bodyBuffer.subarray(textEnd), fakePng);
});

test('manual feedback without attachments omits extra and contexts', async () => {
  const requests = [];
  const diagnostics = createDiagnostics(
    diagnosticsOptions(
      {},
      {
        fetch: async (url, request) => {
          requests.push({ url, request });
          return acceptedResponse();
        },
      },
    ),
  );

  await diagnostics.reportFeedback({ category: 'other', description: 'just text report' });

  const body =
    typeof requests[0].request.body === 'string'
      ? requests[0].request.body
      : Buffer.from(requests[0].request.body).toString('utf8');
  const event = JSON.parse(body.split('\n')[2]);
  assert.equal(event.extra, undefined);
  assert.equal(event.contexts, undefined);
});

test('manual feedback with all attachments delivers session log, app state, and screenshot', async () => {
  const requests = [];
  const diagnostics = createDiagnostics(
    diagnosticsOptions(
      {},
      {
        fetch: async (url, request) => {
          requests.push({ url, request });
          return acceptedResponse();
        },
      },
    ),
  );

  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await diagnostics.reportFeedback(
    {
      category: 'bug',
      description: 'crashed with visual glitch',
      attachmentData: {
        sessionLog: [
          { category: 'session', message: 'mode changed', level: 'info', timestamp: 100 },
        ],
        appState: { interactionMode: 'spec', view: 'chat' },
      },
    },
    { screenshotPng: fakePng },
  );

  assert.equal(requests.length, 1);
  const rawBody = requests[0].request.body;
  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const textEnd = bodyBuffer.length - fakePng.length;
  const textPortion = bodyBuffer.subarray(0, textEnd).toString('utf8');
  const lines = textPortion.split('\n');

  // Event payload has session log + app state
  const event = JSON.parse(lines[2]);
  assert.deepEqual(event.extra.session_log, [
    { category: 'session', message: 'mode changed', level: 'info', timestamp: 100 },
  ]);
  assert.deepEqual(event.contexts.app_state, { interactionMode: 'spec', view: 'chat' });

  // Attachment header has correct length
  const attachmentHeader = JSON.parse(lines[3]);
  assert.equal(attachmentHeader.type, 'attachment');
  assert.equal(attachmentHeader.length, fakePng.length);

  // Raw bytes at end
  assert.deepEqual(bodyBuffer.subarray(textEnd), fakePng);
});
