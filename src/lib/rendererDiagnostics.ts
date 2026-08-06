import * as Sentry from '@sentry/electron/renderer';

interface AutomaticDiagnosticsPreference {
  enabled: boolean;
}

export interface DiagnosticsBreadcrumb {
  category: string;
  message: string;
  level?: 'info' | 'warning' | 'error';
  timestamp: number;
}

export interface DiagnosticsAppState {
  interactionMode?: string;
  autonomy?: string;
  activeSessionCount?: number;
  view?: string;
}

const MAX_BREADCRUMBS = 50;
const SESSION_LOG_CAPACITY = 50;
const ALLOWED_BREADCRUMB_CATEGORIES = new Set(['app', 'session', 'bridge', 'navigation']);

let isInitialized = false;
let currentAppState: DiagnosticsAppState = {};
const sessionLog: DiagnosticsBreadcrumb[] = [];

export async function initializeRendererDiagnostics(): Promise<void> {
  if (isInitialized) return;
  let enabled = false;
  try {
    enabled = (await getAutomaticDiagnostics()).enabled;
  } catch {
    return;
  }
  if (!enabled) return;

  Sentry.init({
    sendDefaultPii: false,
    maxBreadcrumbs: MAX_BREADCRUMBS,
    tracesSampleRate: 0,
    beforeBreadcrumb: filterBreadcrumb,
  });
  isInitialized = true;
  Sentry.setContext('app', currentAppState as Record<string, unknown>);
}

/**
 * Adds an operational breadcrumb visible in crash reports and the manual
 * report session log. Only categories in ALLOWED_BREADCRUMB_CATEGORIES pass
 * the auto-crash filter; user content (prompts, messages, URLs) never does.
 */
export function addDiagnosticsBreadcrumb(
  category: string,
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
): void {
  if (!ALLOWED_BREADCRUMB_CATEGORIES.has(category)) return;
  const entry: DiagnosticsBreadcrumb = {
    category,
    message,
    level,
    timestamp: Date.now(),
  };
  sessionLog.push(entry);
  if (sessionLog.length > SESSION_LOG_CAPACITY) sessionLog.shift();
  if (isInitialized) {
    Sentry.addBreadcrumb({
      category,
      message,
      level,
      type: 'default',
    });
  }
}

export function setDiagnosticsContext(state: DiagnosticsAppState): void {
  currentAppState = { ...state };
  if (isInitialized) {
    Sentry.setContext('app', state as Record<string, unknown>);
  }
}

export function getSessionLog(): DiagnosticsBreadcrumb[] {
  return sessionLog.map((entry) => ({ ...entry }));
}

export function getCurrentAppState(): DiagnosticsAppState {
  return { ...currentAppState };
}

/** @internal Reset module state for deterministic tests. */
export function __resetDiagnosticsForTest(): void {
  sessionLog.length = 0;
  currentAppState = {};
  isInitialized = false;
}

export async function getAutomaticDiagnostics(): Promise<AutomaticDiagnosticsPreference> {
  return normalizePreference(await invokeDiagnosticsBridge('getAutomaticDiagnostics'));
}

export async function setAutomaticDiagnostics(
  enabled: boolean,
): Promise<AutomaticDiagnosticsPreference> {
  return normalizePreference(await invokeDiagnosticsBridge('setAutomaticDiagnostics', [enabled]));
}

function filterBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  if (!breadcrumb.category) return null;
  if (ALLOWED_BREADCRUMB_CATEGORIES.has(breadcrumb.category)) return breadcrumb;
  return null;
}

function invokeDiagnosticsBridge(name: string, args: unknown[] = []): Promise<unknown> {
  const bridge = window.droidControl;
  if (!bridge) return Promise.resolve({ enabled: false });
  const method: unknown = Reflect.get(bridge, name);
  if (typeof method !== 'function') return Promise.resolve({ enabled: false });
  return Promise.resolve(Reflect.apply(method, bridge, args));
}

function normalizePreference(value: unknown): AutomaticDiagnosticsPreference {
  if (!value || typeof value !== 'object' || !('enabled' in value)) {
    throw new Error('Diagnostics preference response is invalid.');
  }
  const enabled = Reflect.get(value, 'enabled');
  if (typeof enabled !== 'boolean') throw new Error('Diagnostics preference response is invalid.');
  return { enabled };
}
