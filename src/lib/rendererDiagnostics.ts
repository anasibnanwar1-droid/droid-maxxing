import * as Sentry from '@sentry/electron/renderer';

interface AutomaticDiagnosticsPreference {
  enabled: boolean;
}

let isInitialized = false;

export async function initializeRendererDiagnostics(): Promise<void> {
  if (isInitialized) return;
  let enabled = false;
  try {
    enabled = (await getAutomaticDiagnostics()).enabled;
  } catch {
    return;
  }
  if (!enabled) return;
  Sentry.init({ sendDefaultPii: false, maxBreadcrumbs: 0, tracesSampleRate: 0 });
  isInitialized = true;
}

export async function getAutomaticDiagnostics(): Promise<AutomaticDiagnosticsPreference> {
  return normalizePreference(await invokeDiagnosticsBridge('getAutomaticDiagnostics'));
}

export async function setAutomaticDiagnostics(
  enabled: boolean,
): Promise<AutomaticDiagnosticsPreference> {
  return normalizePreference(await invokeDiagnosticsBridge('setAutomaticDiagnostics', [enabled]));
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
