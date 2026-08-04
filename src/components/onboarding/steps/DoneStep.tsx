import { useState } from 'react';
import { ArrowRight, Check, Loader2 } from 'lucide-react';

import type { OnboardingController } from '../../../hooks/useOnboarding';
import { BrandMark } from '../../BrandMark';

// Closing cover: the welcome cover mirrored, confirming what is ready before
// the wizard fades into the app itself.
export function DoneStep({
  controller,
  onComplete,
}: {
  controller: OnboardingController;
  onComplete: () => void;
}) {
  const { env } = controller;
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const summary = [
    { label: 'Droid CLI', ok: Boolean(env?.cli.present) },
    {
      label: 'Signed in',
      ok: Boolean(env?.auth.loginPresent) || Boolean(env?.auth.apiKeyConfigured),
    },
  ];

  const finish = async () => {
    setFinishing(true);
    setFinishError(null);
    try {
      await controller.patch({ completed: true });
      onComplete();
    } catch {
      setFinishError("Couldn't finish setup. Try again.");
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div className="flex flex-col items-center text-center">
      <div className="droid-rise">
        <BrandMark size={34} className="text-droid-accent" />
      </div>
      <h1
        className="droid-rise mt-6 text-[22px] leading-snug font-semibold tracking-tight text-droid-text"
        style={{ animationDelay: '90ms' }}
      >
        You&apos;re all set.
      </h1>
      <p
        className="droid-rise mt-3 max-w-[320px] text-[13px] leading-relaxed text-droid-text-muted"
        style={{ animationDelay: '160ms' }}
      >
        The cockpit is yours. Open a session and give your agents something interesting to do.
      </p>
      <div
        className="droid-rise mt-8 w-full max-w-[300px] rounded-xl border border-droid-border bg-droid-surface divide-y divide-droid-border overflow-hidden"
        style={{ animationDelay: '230ms' }}
      >
        {summary.map((row) => (
          <div key={row.label} className="flex items-center justify-between px-4 py-3">
            <span className="text-[13px] text-droid-text-secondary">{row.label}</span>
            {row.ok ? (
              <Check className="w-4 h-4 text-droid-green" strokeWidth={3} />
            ) : (
              <span className="text-[12px] text-droid-text-muted">Pending</span>
            )}
          </div>
        ))}
      </div>
      <div className="droid-rise mt-8" style={{ animationDelay: '300ms' }}>
        <button
          onClick={() => {
            void finish();
          }}
          disabled={finishing}
          className="droid-button-primary inline-flex h-10 items-center gap-2 px-5 text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-droid-bg"
        >
          {finishing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Finishing…
            </>
          ) : (
            <>
              Start building <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
        {finishError && <p className="mt-3 text-[12px] text-droid-red">{finishError}</p>}
      </div>
    </div>
  );
}
