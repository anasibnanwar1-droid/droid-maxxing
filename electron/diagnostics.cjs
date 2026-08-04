const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createEventEnvelope,
  dsnFromString,
  getEnvelopeEndpointWithUrlEncodedAuth,
  serializeEnvelope,
} = require('@sentry/core');

const FEEDBACK_CATEGORIES = new Set(['bug', 'bad_result', 'good_result', 'safety', 'other']);
const MANUAL_FEEDBACK_TAGS = new Set([
  'report_kind',
  'report_id',
  'feedback_category',
  'installation_id',
  'app_version',
  'platform',
  'arch',
  'os_version',
  'electron_version',
  'chrome_version',
  'node_version',
  'packaged',
]);

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

  async function reportFeedback(report) {
    const normalized = normalizeFeedbackReport(report);
    if (!dsn) throw new Error('Feedback reporting is not configured for this build.');
    const { userId } = await installationIdentity();
    const reportId = createReportId(options.now?.() ?? new Date(), options.randomBytes);
    const technicalDiagnostics = createTechnicalDiagnostics(options);
    const eventId = createEventId(options.eventRandomBytes);
    const event = scrubManualFeedbackEvent({
      event_id: eventId,
      timestamp: (options.now?.() ?? new Date()).toISOString(),
      message: normalized.description,
      level: 'info',
      platform: 'javascript',
      release: `droidex@${options.app.getVersion()}`,
      environment: options.app.isPackaged ? 'production' : 'development',
      tags: {
        report_kind: 'manual_feedback',
        report_id: reportId,
        feedback_category: normalized.category,
        installation_id: userId,
        ...technicalDiagnostics,
      },
      user: { id: userId },
    });
    await deliverFeedbackEvent(event, {
      dsn,
      fetch: options.fetch,
      timeoutMs: options.deliveryTimeoutMs,
    });
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

  return { initialize, reportFeedback, captureException, installationIdentity };
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

function normalizeFeedbackReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Feedback report must be an object.');
  }
  if (!FEEDBACK_CATEGORIES.has(value.category)) {
    throw new Error('Feedback category is invalid.');
  }
  if (typeof value.description !== 'string') {
    throw new Error('Feedback description must be text.');
  }
  const description = value.description.trim();
  if (description.length < 5) throw new Error('Describe the report in at least 5 characters.');
  if (description.length > 2_000)
    throw new Error('Feedback description must be 2,000 characters or less.');
  return { category: value.category, description };
}

function createReportId(date, randomBytes = crypto.randomBytes) {
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  return `RPT-${day}-${randomBytes(6).toString('hex').toUpperCase()}`;
}

function createEventId(randomBytes = crypto.randomBytes) {
  return randomBytes(16).toString('hex');
}

function createTechnicalDiagnostics(options) {
  const versions = options.versions || process.versions;
  const systemVersion = options.systemVersion?.() || process.getSystemVersion?.() || os.release();
  return {
    app_version: options.app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    os_version: systemVersion,
    electron_version: versions.electron || 'unknown',
    chrome_version: versions.chrome || 'unknown',
    node_version: versions.node || 'unknown',
    packaged: String(Boolean(options.app.isPackaged)),
  };
}

function scrubEvent(event) {
  if (event.tags?.report_kind === 'manual_feedback') return scrubManualFeedbackEvent(event);
  const sanitized = { ...event, breadcrumbs: [], request: undefined };
  if (event.user?.id) sanitized.user = { id: event.user.id };
  else delete sanitized.user;
  return sanitized;
}

function scrubManualFeedbackEvent(event) {
  const tags = Object.fromEntries(
    Object.entries(event.tags || {}).filter(([key]) => MANUAL_FEEDBACK_TAGS.has(key)),
  );
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    message: event.message,
    level: event.level,
    platform: event.platform,
    release: event.release,
    environment: event.environment,
    tags,
    user: event.user?.id ? { id: event.user.id } : undefined,
  };
}

async function deliverFeedbackEvent(event, options) {
  const dsn = dsnFromString(options.dsn);
  if (!dsn) throw new Error('Feedback reporting configuration is invalid.');
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Feedback delivery is unavailable in this runtime.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 5_000);
  let response;
  try {
    response = await fetchImpl(getEnvelopeEndpointWithUrlEncodedAuth(dsn), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: serializeEnvelope(createEventEnvelope({ ...event }, dsn)),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Feedback delivery timed out. Check your connection and try again.');
    }
    throw new Error('Feedback delivery failed. Check your connection and try again.', {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(
      `Feedback delivery was rejected by Sentry (${String(response.status)}). Try again.`,
    );
  }
}

module.exports = {
  createDiagnostics,
  createEventId,
  createReportId,
  createTechnicalDiagnostics,
  deliverFeedbackEvent,
  loadOrCreateIdentity,
  normalizeFeedbackReport,
  scrubEvent,
  scrubManualFeedbackEvent,
};
