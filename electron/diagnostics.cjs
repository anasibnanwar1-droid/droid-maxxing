const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function createDiagnostics(options) {
  const sentry = options.sentry;
  const dsn = options.dsn || '';
  let identityPromise = null;

  function initialize() {
    if (!dsn) return false;
    sentry.init({
      dsn,
      release: `droidex@${options.app.getVersion()}`,
      environment: options.app.isPackaged ? 'production' : 'development',
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
      beforeBreadcrumb: () => null,
      beforeSend: scrubEvent,
    });
    void installationIdentity().then(({ userId }) => sentry.setUser({ id: userId }));
    return true;
  }

  async function reportBug(description) {
    const normalized = normalizeDescription(description);
    if (!dsn) throw new Error('Bug reporting is not configured for this build.');
    const { userId } = await installationIdentity();
    const reportId = createReportId(options.now?.() ?? new Date(), options.randomBytes);
    let eventId = '';
    sentry.withScope((scope) => {
      scope.setUser({ id: userId });
      scope.setTags({
        report_id: reportId,
        installation_id: userId,
        app_version: options.app.getVersion(),
        platform: process.platform,
        arch: process.arch,
      });
      eventId = sentry.captureMessage(normalized, { level: 'error' });
    });
    if (!(await sentry.flush(5_000))) {
      throw new Error('Bug report delivery timed out. Check your connection and try again.');
    }
    return { reportId, userId, eventId };
  }

  function captureException(error, tags = {}) {
    if (!dsn) return undefined;
    return sentry.withScope((scope) => {
      scope.setTags(tags);
      return sentry.captureException(error);
    });
  }

  function installationIdentity() {
    identityPromise ??= loadOrCreateIdentity({
      filePath: path.join(options.app.getPath('userData'), 'diagnostics.json'),
      randomUUID: options.randomUUID || crypto.randomUUID,
      fs: options.fs || fs,
    });
    return identityPromise;
  }

  return { initialize, reportBug, captureException, installationIdentity };
}

async function loadOrCreateIdentity(options) {
  try {
    const parsed = JSON.parse(await options.fs.readFile(options.filePath, 'utf8'));
    if (
      parsed?.version === 1 &&
      typeof parsed.userId === 'string' &&
      /^USR-[A-F0-9]{12}$/.test(parsed.userId)
    ) {
      return { userId: parsed.userId };
    }
  } catch {
    // Missing or invalid derived diagnostics identity is replaced below.
  }
  const userId = `USR-${options.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  await options.fs.mkdir(path.dirname(options.filePath), { recursive: true, mode: 0o700 });
  await options.fs.writeFile(
    options.filePath,
    `${JSON.stringify({ version: 1, userId }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { userId };
}

function normalizeDescription(value) {
  if (typeof value !== 'string') throw new Error('Bug description must be text.');
  const description = value.trim();
  if (description.length < 5) throw new Error('Describe the bug in at least 5 characters.');
  if (description.length > 2_000)
    throw new Error('Bug description must be 2,000 characters or less.');
  return description;
}

function createReportId(date, randomBytes = crypto.randomBytes) {
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  return `BUG-${day}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function scrubEvent(event) {
  const sanitized = { ...event, breadcrumbs: [], request: undefined };
  if (event.user?.id) sanitized.user = { id: event.user.id };
  else delete sanitized.user;
  return sanitized;
}

module.exports = {
  createDiagnostics,
  createReportId,
  loadOrCreateIdentity,
  normalizeDescription,
  scrubEvent,
};
