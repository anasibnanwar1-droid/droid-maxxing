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
const AUTOMATIC_DIAGNOSTICS_DEFAULT = true;
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
  let isInitialized = false;

  async function initialize() {
    if (!dsn || isInitialized) return isInitialized;
    try {
      if (!(await automaticDiagnosticsPreference()).enabled) return false;
      const { userId } = await installationIdentity();
      sentry.init({
        dsn,
        release: `droidex@${options.app.getVersion()}`,
        environment: options.app.isPackaged ? 'production' : 'development',
        initialScope: { user: { id: userId } },
        sendDefaultPii: false,
        maxBreadcrumbs: 50,
        tracesSampleRate: 0,
        beforeBreadcrumb: filterBreadcrumb,
        beforeSend: scrubEvent,
      });
      isInitialized = true;
    } catch (error) {
      options.logError?.('Sentry initialization skipped', error);
      return false;
    }
    return true;
  }

  function automaticDiagnosticsPreference() {
    return loadAutomaticDiagnosticsPreference({
      filePath: preferenceFilePath(),
      fs: options.fs || fs,
    });
  }

  async function setAutomaticDiagnosticsEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Diagnostics preference must be boolean.');
    const fileSystem = options.fs || fs;
    await saveAutomaticDiagnosticsPreference({
      filePath: preferenceFilePath(),
      enabled,
      fs: fileSystem,
    });
    if (enabled) {
      await initialize();
      return { enabled: true };
    }

    if (isInitialized && typeof sentry.close === 'function') {
      try {
        await sentry.close(2_000);
      } catch (error) {
        options.logError?.('Sentry shutdown failed', error);
      }
    }
    isInitialized = false;
    identityPromise = null;
    try {
      await fileSystem.unlink(identityFilePath());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { enabled: false };
  }

  async function reportFeedback(report, context = {}) {
    const normalized = normalizeFeedbackReport(report);
    if (!dsn) throw new Error('Feedback reporting is not configured for this build.');
    const { userId } = await manualFeedbackIdentity();
    const reportId = createReportId(options.now?.() ?? new Date(), options.randomBytes);
    const technicalDiagnostics = createTechnicalDiagnostics(options);
    const eventId = createEventId(options.eventRandomBytes);
    const attachmentData = normalizeAttachmentData(report.attachmentData);
    const screenshotPng = context.screenshotPng || null;
    const event = scrubManualFeedbackEvent({
      event_id: eventId,
      timestamp: (options.now?.() ?? new Date()).toISOString(),
      message: normalized.description,
      level: 'error',
      exception: manualFeedbackException(normalized.description),
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
      extra: buildExtra(attachmentData),
      contexts: buildContexts(attachmentData),
    });
    await deliverFeedbackEvent(event, {
      dsn,
      fetch: options.fetch,
      timeoutMs: options.deliveryTimeoutMs,
      screenshotPng,
    });
    return { reportId, userId, eventId };
  }

  function captureException(error, tags = {}) {
    if (!dsn || !isInitialized) return undefined;
    return sentry.withScope((scope) => {
      scope.setTags(tags);
      return sentry.captureException(error);
    });
  }

  function installationIdentity() {
    identityPromise ??= loadOrCreateIdentity({
      filePath: identityFilePath(),
      randomUUID: options.randomUUID || crypto.randomUUID,
      fs: options.fs || fs,
    });
    return identityPromise;
  }

  async function manualFeedbackIdentity() {
    try {
      if ((await automaticDiagnosticsPreference()).enabled) return installationIdentity();
    } catch (error) {
      options.logError?.(
        'Diagnostics preference could not be read; using report-scoped identity',
        error,
      );
    }
    return { userId: createPseudonymousUserId(options.randomUUID || crypto.randomUUID) };
  }

  function identityFilePath() {
    return path.join(options.app.getPath('userData'), 'diagnostics.json');
  }

  function preferenceFilePath() {
    return path.join(options.app.getPath('userData'), 'diagnostics-preferences.json');
  }

  return {
    initialize,
    reportFeedback,
    captureException,
    installationIdentity,
    automaticDiagnosticsPreference,
    setAutomaticDiagnosticsEnabled,
  };
}

async function loadAutomaticDiagnosticsPreference(options) {
  try {
    const parsed = JSON.parse(await options.fs.readFile(options.filePath, 'utf8'));
    if (parsed?.version === 1 && typeof parsed.enabled === 'boolean') {
      return { enabled: parsed.enabled };
    }
    throw new Error('Diagnostics preference is invalid. Toggle it again in Settings.');
  } catch (error) {
    if (error?.code === 'ENOENT') return { enabled: AUTOMATIC_DIAGNOSTICS_DEFAULT };
    throw error;
  }
}

async function saveAutomaticDiagnosticsPreference(options) {
  const temporaryPath = `${options.filePath}.${crypto.randomUUID()}.tmp`;
  await options.fs.mkdir(path.dirname(options.filePath), { recursive: true, mode: 0o700 });
  try {
    await options.fs.writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, enabled: options.enabled }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await options.fs.rename(temporaryPath, options.filePath);
  } catch (error) {
    try {
      await options.fs.unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
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
  const userId = createPseudonymousUserId(options.randomUUID);
  await options.fs.mkdir(path.dirname(options.filePath), { recursive: true, mode: 0o700 });
  await options.fs.writeFile(
    options.filePath,
    `${JSON.stringify({ version: 1, userId }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { userId };
}

function createPseudonymousUserId(randomUUID = crypto.randomUUID) {
  return `USR-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
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
  const filteredBreadcrumbs = Array.isArray(event.breadcrumbs)
    ? event.breadcrumbs.filter((b) => filterBreadcrumb(b) !== null)
    : [];
  const sanitized = { ...event, breadcrumbs: filteredBreadcrumbs, request: undefined };
  if (event.user?.id) sanitized.user = { id: event.user.id };
  else delete sanitized.user;
  return sanitized;
}

function scrubManualFeedbackEvent(event) {
  const tags = Object.fromEntries(
    Object.entries(event.tags || {}).filter(([key]) => MANUAL_FEEDBACK_TAGS.has(key)),
  );
  const sanitized = {
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
  if (event.level === 'error' && typeof event.message === 'string') {
    sanitized.exception = manualFeedbackException(event.message);
  }
  if (event.extra && typeof event.extra === 'object') {
    const filtered = Object.fromEntries(
      Object.entries(event.extra).filter(([key]) => MANUAL_FEEDBACK_EXTRA_KEYS.has(key)),
    );
    if (Object.keys(filtered).length > 0) sanitized.extra = sanitizeAttachmentData(filtered);
  }
  if (event.contexts && typeof event.contexts === 'object') {
    const filtered = Object.fromEntries(
      Object.entries(event.contexts).filter(([key]) => MANUAL_FEEDBACK_CONTEXT_KEYS.has(key)),
    );
    if (Object.keys(filtered).length > 0) sanitized.contexts = sanitizeAttachmentData(filtered);
  }
  return sanitized;
}

function manualFeedbackException(description) {
  return {
    values: [
      {
        type: 'UserSubmittedReport',
        value: description,
        mechanism: { type: 'droidex.feedback', handled: true },
      },
    ],
  };
}

function sanitizeAttachmentData(data) {
  const result = Object.create(null);
  for (const [key, value] of Object.entries(data)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      result[key] = value.map(sanitizeAttachmentEntry).filter((v) => v !== null);
    } else if (typeof value === 'object') {
      result[key] = sanitizeAttachmentData(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function sanitizeAttachmentEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const category = typeof entry.category === 'string' ? entry.category.slice(0, 64) : 'unknown';
  const message = typeof entry.message === 'string' ? entry.message.slice(0, 500) : '';
  const level = ['info', 'warning', 'error'].includes(entry.level) ? entry.level : 'info';
  const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : Date.now();
  return { category, message, level, timestamp };
}

const ALLOWED_BREADCRUMB_CATEGORIES = new Set(['app', 'session', 'bridge', 'navigation']);
const MANUAL_FEEDBACK_EXTRA_KEYS = new Set(['session_log']);
const MANUAL_FEEDBACK_CONTEXT_KEYS = new Set(['app_state']);
const ALLOWED_APP_STATE_KEYS = new Set([
  'interactionMode',
  'autonomy',
  'activeSessionCount',
  'view',
]);

function filterBreadcrumb(breadcrumb) {
  if (!breadcrumb?.category) return null;
  if (ALLOWED_BREADCRUMB_CATEGORIES.has(breadcrumb.category)) return breadcrumb;
  return null;
}

function normalizeAttachmentData(data) {
  if (!data || typeof data !== 'object') return {};
  const result = {};
  if (Array.isArray(data.sessionLog)) {
    result.sessionLog = data.sessionLog
      .filter((entry) => entry && typeof entry === 'object')
      .map(sanitizeAttachmentEntry)
      .slice(-50);
  }
  if (data.appState && typeof data.appState === 'object') {
    const filtered = {};
    for (const [key, value] of Object.entries(data.appState)) {
      if (ALLOWED_APP_STATE_KEYS.has(key)) filtered[key] = value;
    }
    result.appState = filtered;
  }
  return result;
}

function buildExtra(attachmentData) {
  if (!attachmentData.sessionLog) return undefined;
  return { session_log: attachmentData.sessionLog };
}

function buildContexts(attachmentData) {
  if (!attachmentData.appState) return undefined;
  return { app_state: attachmentData.appState };
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
    const envelope = createEventEnvelope({ ...event }, dsn);
    if (options.screenshotPng && options.screenshotPng.length > 0) {
      envelope[1].push([
        {
          type: 'attachment',
          length: options.screenshotPng.length,
          filename: 'screenshot.png',
          content_type: 'image/png',
          attachment_type: 'event.attachment',
        },
        options.screenshotPng,
      ]);
    }
    response = await fetchImpl(getEnvelopeEndpointWithUrlEncodedAuth(dsn), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: serializeEnvelope(envelope),
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

  let acknowledgment;
  try {
    acknowledgment = await response.json();
  } catch {
    throw new Error('Sentry did not acknowledge this report. Try again.');
  }
  const acknowledgedEventId = acknowledgment?.id;
  if (
    typeof acknowledgedEventId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(acknowledgedEventId) ||
    acknowledgedEventId !== event.event_id
  ) {
    throw new Error('Sentry did not acknowledge this report. Try again.');
  }
  return { eventId: acknowledgedEventId };
}

module.exports = {
  AUTOMATIC_DIAGNOSTICS_DEFAULT,
  createDiagnostics,
  createEventId,
  createReportId,
  createTechnicalDiagnostics,
  createPseudonymousUserId,
  deliverFeedbackEvent,
  filterBreadcrumb,
  loadOrCreateIdentity,
  loadAutomaticDiagnosticsPreference,
  normalizeAttachmentData,
  normalizeFeedbackReport,
  scrubEvent,
  scrubManualFeedbackEvent,
  saveAutomaticDiagnosticsPreference,
};
