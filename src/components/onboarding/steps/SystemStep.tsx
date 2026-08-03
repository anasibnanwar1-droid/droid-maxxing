import { ArrowRight } from 'lucide-react';

import type { OnboardingController } from '../../../hooks/useOnboarding';
import { Panel, PrimaryButton, RescanButton, StatusDot, StepLabel, StepTitle } from '../kit';

export function SystemStep({
  controller,
  onNext,
}: {
  controller: OnboardingController;
  onNext: () => void;
}) {
  const { env, refreshEnv } = controller;

  const cli = env?.cli;
  const auth = env?.auth;
  const rows = [
    {
      label: 'Droid CLI',
      status: !env ? 'pending' : cli?.present ? 'ok' : 'missing',
      detail: cli?.present
        ? `${cli.version ?? 'installed'} · ${cli.path}`
        : 'Not found — the next step installs it',
    },
    {
      label: 'Factory account',
      status: !env ? 'pending' : auth?.loginPresent || auth?.apiKeyConfigured ? 'ok' : 'missing',
      detail:
        auth?.loginPresent || auth?.apiKeyConfigured
          ? 'Signed in'
          : 'Sign in later in this setup, or from Settings',
    },
    {
      label: 'Node.js',
      status: !env ? 'pending' : env.node.present ? 'ok' : 'missing',
      detail: env?.node.present
        ? (env.node.version ?? 'installed')
        : 'Not found — only needed for the npm install channel',
    },
  ] as const;

  const ready = Boolean(cli?.present);

  return (
    <div className="w-full max-w-[520px] mx-auto">
      <StepLabel>System check</StepLabel>
      <StepTitle
        title="A quick look under the hood."
        sub="DROIDEX checked the essentials on this machine. Anything missing can be fixed in the next steps."
      />

      <Panel className="mb-7">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3.5 px-4 py-3.5">
            <StatusDot status={row.status} />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] text-droid-text">{row.label}</div>
              <div className="text-[11.5px] font-mono text-droid-text-muted truncate mt-0.5">
                {row.detail}
              </div>
            </div>
          </div>
        ))}
      </Panel>

      {ready ? (
        <PrimaryButton onClick={onNext} autoFocus>
          Continue <ArrowRight className="w-4 h-4" />
        </PrimaryButton>
      ) : (
        <div className="flex gap-2">
          <div className="flex-1">
            <RescanButton
              onClick={() => {
                refreshEnv();
              }}
            />
          </div>
          <div className="flex-1">
            <PrimaryButton onClick={onNext} autoFocus>
              Continue <ArrowRight className="w-4 h-4" />
            </PrimaryButton>
          </div>
        </div>
      )}
    </div>
  );
}
