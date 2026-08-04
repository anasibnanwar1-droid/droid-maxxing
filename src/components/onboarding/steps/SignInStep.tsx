import { useState } from 'react';
import { ArrowRight, Check, KeyRound, Loader2 } from 'lucide-react';

import type { OnboardingController } from '../../../hooks/useOnboarding';
import { BackButton, GhostButton, PrimaryButton, StepLabel, StepTitle } from '../kit';

export function SignInStep({
  controller,
  onNext,
  onBack,
}: {
  controller: OnboardingController;
  onNext: () => void;
  onBack: () => void;
}) {
  const { env } = controller;
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const signedIn = Boolean(env?.auth.loginPresent) || Boolean(env?.auth.apiKeyConfigured);

  const saveKey = async () => {
    setSaving(true);
    setKeyError(null);
    try {
      await controller.saveApiKey(key);
    } catch {
      setKeyError(
        "Couldn't save the API key. Check that secure storage is available and try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full max-w-[520px] mx-auto">
      <StepLabel>Factory account</StepLabel>
      <StepTitle
        title="Bring your account."
        sub="DROIDEX uses the account already configured in the Droid CLI."
      />

      {signedIn ? (
        <div className="rounded-xl border border-droid-border bg-droid-surface px-4 py-3.5 mb-6 flex items-center gap-2.5 text-[13.5px] text-droid-text">
          <Check className="w-4 h-4 text-droid-green" strokeWidth={3} /> You&apos;re signed in.
        </div>
      ) : (
        <div className="space-y-2 mb-6">
          <PrimaryButton
            onClick={() => {
              controller.refreshEnv();
            }}
            disabled={!env?.cli.present}
          >
            <Check className="w-4 h-4" /> Check CLI sign-in
          </PrimaryButton>
          {!env?.cli.present && (
            <p className="text-[12px] text-droid-text-muted text-center">
              Install the Droid CLI first.
            </p>
          )}
          {env?.cli.present && (
            <p className="text-[12px] text-droid-text-muted text-center">
              Sign in with the Droid CLI in Terminal, then check the status here.
            </p>
          )}
          {!showKey ? (
            <button
              onClick={() => {
                setShowKey(true);
              }}
              className="w-full text-[12.5px] text-droid-text-muted hover:text-droid-text transition-colors py-2 flex items-center justify-center gap-1.5"
            >
              <KeyRound className="w-3.5 h-3.5" /> Use an API key instead
            </button>
          ) : (
            <div className="rounded-xl border border-droid-border bg-droid-surface p-3.5 space-y-2">
              <input
                type="password"
                aria-label="Factory API key"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                }}
                placeholder="FACTORY_API_KEY"
                className="droid-input w-full font-mono text-[12px]"
              />
              <PrimaryButton
                onClick={() => {
                  void saveKey();
                }}
                disabled={!key.trim() || saving}
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save key'}
              </PrimaryButton>
              {keyError && <p className="text-[12px] text-droid-red">{keyError}</p>}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <BackButton onClick={onBack} />
        <div className="flex-1">
          {signedIn ? (
            <PrimaryButton onClick={onNext}>
              Continue <ArrowRight className="w-4 h-4" />
            </PrimaryButton>
          ) : (
            <GhostButton onClick={onNext}>Skip for now</GhostButton>
          )}
        </div>
      </div>
    </div>
  );
}
