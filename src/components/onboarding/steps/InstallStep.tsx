import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Download, Loader2, RefreshCw } from 'lucide-react';

import type { OnboardingController } from '../../../hooks/useOnboarding';
import type { InstallChannel } from '../../../types/bridge';
import { BackButton, GhostButton, Panel, PrimaryButton, StepLabel, StepTitle } from '../kit';

const CHANNEL_LABEL: Record<InstallChannel, string> = {
  script: 'Official installer',
  brew: 'Homebrew',
  npm: 'npm',
};

// eslint-disable-next-line react-refresh/only-export-components
export function selectInstallChannel(
  channels: InstallChannel[],
  selected: InstallChannel | null,
): InstallChannel | null {
  return selected && channels.includes(selected) ? selected : (channels[0] ?? null);
}

export function InstallStep({
  controller,
  onNext,
  onBack,
}: {
  controller: OnboardingController;
  onNext: () => void;
  onBack: () => void;
}) {
  const { env, installLog, installing, lastResult, install, refreshEnv } = controller;
  const channels = useMemo(() => env?.availableChannels ?? [], [env?.availableChannels]);
  const [channel, setChannel] = useState<InstallChannel | null>(() =>
    selectInstallChannel(channels, null),
  );
  useEffect(() => {
    const nextChannel = selectInstallChannel(channels, channel);
    if (nextChannel !== channel) setChannel(nextChannel);
  }, [channels, channel]);

  const installed = Boolean(env?.cli.present);
  const detectedCli = env?.cli;
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [installLog]);

  if (installed) {
    return (
      <div className="w-full max-w-[520px] mx-auto">
        <StepLabel>Droid CLI</StepLabel>
        <StepTitle
          title="The CLI is ready."
          sub={`Detected ${detectedCli?.version ? `v${detectedCli.version}` : 'an installation'} at ${detectedCli?.path ?? 'droid'}.`}
        />
        <PrimaryButton onClick={onNext}>
          Continue <ArrowRight className="w-4 h-4" />
        </PrimaryButton>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[520px] mx-auto">
      <StepLabel>Droid CLI</StepLabel>
      <StepTitle
        title="Install the engine."
        sub="Droid agents run on the Factory CLI. Pick how you'd like to install it — DROIDEX handles the rest."
      />

      {channels.length === 0 && (
        <div className="rounded-xl border border-droid-border bg-droid-surface px-4 py-3.5 text-[13px] text-droid-text-secondary mb-4">
          <p className="text-droid-orange mb-1">No supported package manager found.</p>
          Install Homebrew, npm, or curl, then re-scan. You can also skip this for now and finish
          setup later.
        </div>
      )}
      {channels.length > 0 && (
        <div role="radiogroup" aria-label="Droid CLI installation method" className="mb-4">
          <Panel>
            {channels.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={channel === c}
                onClick={() => {
                  setChannel(c);
                }}
                disabled={!!installing}
                className="w-full flex items-center justify-between px-4 py-3.5 text-left transition-colors hover:bg-droid-elevated/50"
              >
                <span className="flex items-center gap-3 text-[13.5px] text-droid-text">
                  <span
                    className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                      channel === c ? 'border-droid-accent' : 'border-droid-border-hover'
                    }`}
                  >
                    {channel === c && <span className="w-1.5 h-1.5 rounded-full bg-droid-accent" />}
                  </span>
                  {CHANNEL_LABEL[c]}
                </span>
                {channel === c && <Check className="w-4 h-4 text-droid-accent" strokeWidth={3} />}
              </button>
            ))}
          </Panel>
        </div>
      )}

      {(Boolean(installing) || installLog.length > 0) && (
        <div
          ref={logRef}
          className="mb-4 max-h-40 overflow-auto rounded-xl border border-droid-border bg-droid-surface p-3.5 font-mono text-[11px] leading-5 text-droid-text-muted"
        >
          {installLog.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              {line}
            </div>
          ))}
          {installing && (
            <div className="flex items-center gap-1.5 text-droid-text-secondary">
              <Loader2 className="w-3 h-3 animate-spin" /> working…
            </div>
          )}
        </div>
      )}

      {lastResult && !lastResult.ok && (
        <p className="text-[12px] text-droid-red mb-3">
          Installation didn&apos;t finish. Review the log and try again.
        </p>
      )}

      {installing ? (
        <PrimaryButton onClick={onNext} disabled>
          <Loader2 className="w-4 h-4 animate-spin" /> Installing…
        </PrimaryButton>
      ) : channels.length === 0 ? (
        <PrimaryButton
          onClick={() => {
            refreshEnv();
          }}
        >
          <RefreshCw className="w-4 h-4" /> Re-scan
        </PrimaryButton>
      ) : (
        <PrimaryButton
          onClick={() => {
            if (channel) install(channel);
          }}
          disabled={!channel}
        >
          <Download className="w-4 h-4" /> Install with{' '}
          {channel ? CHANNEL_LABEL[channel] : 'package manager'}
        </PrimaryButton>
      )}

      {!installing && (
        <div className="flex items-center gap-2 mt-2">
          <BackButton onClick={onBack} />
          <div className="flex-1">
            <GhostButton onClick={onNext}>Skip for now</GhostButton>
          </div>
        </div>
      )}
    </div>
  );
}
