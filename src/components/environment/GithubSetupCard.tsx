import { CircleUserRound, Download, ExternalLink, GitPullRequest, Loader2 } from 'lucide-react';

import type { GithubAvailability } from '../../types/vcs';
import type { GithubSetupAction } from '../../hooks/useGithubSetup';

export interface GithubSetupCardProps {
  availability: GithubAvailability | null;
  action: GithubSetupAction;
  error: string | null;
  manualGuideOpened: boolean;
  onPrimaryAction: () => void;
}

interface SetupContent {
  title: string;
  description: string;
  label: string;
  icon: 'download' | 'external' | 'signin' | 'busy';
}

function setupContent(
  availability: GithubAvailability,
  action: GithubSetupAction,
  manualGuideOpened: boolean,
): SetupContent {
  if (action === 'installing') {
    return {
      title: 'GitHub CLI required',
      description: 'Install GitHub CLI to load pull requests, checks, and comments.',
      label: 'Installing…',
      icon: 'busy',
    };
  }
  if (action === 'authenticating') {
    return {
      title: 'Connect GitHub',
      description: 'Sign in through GitHub CLI to load pull requests, checks, and comments.',
      label: 'Waiting for GitHub…',
      icon: 'busy',
    };
  }
  if (availability.installed) {
    return {
      title: 'Connect GitHub',
      description: 'Sign in through GitHub CLI to load pull requests, checks, and comments.',
      label: 'Sign in to GitHub',
      icon: 'signin',
    };
  }
  if (availability.installMethod === 'manual') {
    return {
      title: 'GitHub CLI required',
      description: 'Use the official installation page, then return here to check GitHub CLI.',
      label: manualGuideOpened ? 'Check installation' : 'Install GitHub CLI',
      icon: 'external',
    };
  }
  return {
    title: 'GitHub CLI required',
    description: 'Install GitHub CLI to load pull requests, checks, and comments.',
    label: 'Install GitHub CLI',
    icon: 'download',
  };
}

function SetupActionIcon({ icon }: { icon: SetupContent['icon'] }) {
  switch (icon) {
    case 'busy':
      return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
    case 'signin':
      return <CircleUserRound className="h-3.5 w-3.5" />;
    case 'external':
      return <ExternalLink className="h-3.5 w-3.5" />;
    case 'download':
      return <Download className="h-3.5 w-3.5" />;
  }
}

export function GithubSetupCard({
  availability,
  action,
  error,
  manualGuideOpened,
  onPrimaryAction,
}: GithubSetupCardProps) {
  if (!availability || (availability.installed && availability.authenticated)) return null;

  const isBusy = action !== 'idle';
  const content = setupContent(availability, action, manualGuideOpened);

  return (
    <div className="mx-1.5 mt-1.5 rounded-xl border border-droid-border bg-droid-surface px-3 py-2.5">
      <div className="flex items-start gap-2">
        <GitPullRequest className="mt-0.5 h-4 w-4 shrink-0 text-droid-text-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-droid-text">{content.title}</div>
          <p className="mt-0.5 text-[11.5px] leading-4 text-droid-text-muted">
            {content.description}
          </p>
          <div aria-live="polite">
            {error && <p className="mt-1.5 text-[11.5px] leading-4 text-droid-red">{error}</p>}
          </div>
          <button
            type="button"
            disabled={isBusy}
            onClick={onPrimaryAction}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-droid-border bg-droid-elevated px-2.5 py-1.5 text-[11.5px] font-medium text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <SetupActionIcon icon={content.icon} />
            {content.label}
          </button>
        </div>
      </div>
    </div>
  );
}
