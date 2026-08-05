import { useEffect, useState } from 'react';
import { getAutomaticDiagnostics, setAutomaticDiagnostics } from '../lib/rendererDiagnostics';
import { Switch } from './Switch';

export function DiagnosticsSettings() {
  const [enabled, setEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void getAutomaticDiagnostics()
      .then((preference) => {
        if (active) setEnabled(preference.enabled);
      })
      .catch(() => {
        if (active) setError('Could not load the diagnostics preference.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const update = async (nextEnabled: boolean) => {
    setIsLoading(true);
    setError('');
    try {
      const preference = await setAutomaticDiagnostics(nextEnabled);
      setEnabled(preference.enabled);
    } catch {
      setError('Could not save the diagnostics preference. Try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-7">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-droid-text">
          Privacy & diagnostics
        </h1>
        <p className="mt-1.5 max-w-xl text-[12px] leading-5 text-droid-text-muted">
          Control the automatic operational data DROIDEX sends to its private Sentry project.
        </p>
      </div>

      <div className="mb-3 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
        Automatic diagnostics
      </div>
      <div className="rounded-xl border border-droid-border bg-droid-surface">
        <div className="flex items-start justify-between gap-5 px-4 py-4">
          <div className="min-w-0">
            <div className="text-[13px] text-droid-text">Crash reports and Release Health</div>
            <p className="mt-1 max-w-xl text-[11px] leading-[17px] text-droid-text-muted">
              Sends app version, runtime and device context, crash stacks, native crash dumps, and a
              random local profile ID. Crash material can contain incidental sensitive data. It does
              not intentionally attach account identity as structured data. A minidump can still
              contain incidental account or credential data and is not used for feature analytics.
            </p>
          </div>
          <Switch
            label="Automatic crash reports and Release Health"
            checked={enabled}
            disabled={isLoading}
            onChange={(value) => void update(value)}
          />
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-[17px] text-droid-text-muted">
        Changes apply immediately. Turning it off stops automatic reporting and deletes the local
        profile ID. Reports you explicitly submit through <span className="font-mono">/bug</span> or{' '}
        <span className="font-mono">/feedback</span> are still sent when you choose Submit.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
