import { useRef, useState } from 'react';
import {
  Check,
  CircleUserRound,
  Copy,
  Download,
  ExternalLink,
  GitPullRequest,
  Loader2,
} from 'lucide-react';

import type { GithubAvailability } from '../../types/vcs';
import type { GithubSetupAction } from '../../hooks/useGithubSetup';
import { Popover } from './Popover';

export interface GithubSetupCardProps {
  availability: GithubAvailability | null;
  action: GithubSetupAction;
  error: string | null;
  manualGuideOpened: boolean;
  authCode: string | null;
  isAuthPopoverOpen: boolean;
  onPrimaryAction: () => void;
  onShowAuthPrompt: () => void;
  onCloseAuthPrompt: () => void;
  onCancelAuthentication: () => void;
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
  authCode: string | null,
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
    if (authCode) {
      return {
        title: 'Connect GitHub',
        description: 'GitHub is waiting for the one-time code shown here.',
        label: 'Show sign-in code',
        icon: 'signin',
      };
    }
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

export function GithubAuthPromptContent({
  code,
  copied = false,
  onCopy,
  onCancel,
}: {
  code: string;
  copied?: boolean;
  onCopy: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="p-3.5">
      <div className="text-[13px] font-semibold text-droid-text">Enter this code on GitHub</div>
      <p className="mt-1 text-[11.5px] leading-4 text-droid-text-muted">
        Paste this code into GitHub’s device activation page. The browser is already open.
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-droid-border bg-droid-elevated p-2">
        <code className="min-w-0 flex-1 select-all text-center font-mono text-[16px] font-semibold tracking-[0.12em] text-droid-text">
          {code}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-droid-border bg-droid-surface px-2 py-1.5 text-[11.5px] font-medium text-droid-text-secondary hover:border-droid-border-hover hover:text-droid-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/60"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy code'}
        </button>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-1.5 text-[11.5px] font-medium text-droid-text-muted hover:bg-droid-elevated hover:text-droid-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/60"
        >
          Cancel sign-in
        </button>
      </div>
    </div>
  );
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
  authCode,
  isAuthPopoverOpen,
  onPrimaryAction,
  onShowAuthPrompt,
  onCloseAuthPrompt,
  onCancelAuthentication,
}: GithubSetupCardProps) {
  const actionRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  if (!availability || (availability.installed && availability.authenticated)) return null;

  const isBusy = action !== 'idle' && !authCode;
  const content = setupContent(availability, action, manualGuideOpened, authCode);

  const copyCode = () => {
    if (!authCode) return;
    void navigator.clipboard
      .writeText(authCode)
      .then(() => {
        setCopied(true);
      })
      .catch(() => {
        setCopied(false);
      });
  };

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
            ref={actionRef}
            type="button"
            disabled={isBusy}
            onClick={authCode ? onShowAuthPrompt : onPrimaryAction}
            aria-haspopup={authCode ? 'dialog' : undefined}
            aria-expanded={authCode ? isAuthPopoverOpen : undefined}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-droid-border bg-droid-elevated px-2.5 py-1.5 text-[11.5px] font-medium text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-droid-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <SetupActionIcon icon={content.icon} />
            {content.label}
          </button>
          {authCode && (
            <Popover
              open={isAuthPopoverOpen}
              onClose={onCloseAuthPrompt}
              anchorRef={actionRef}
              label="GitHub sign-in code"
              align="left"
              width={320}
            >
              <GithubAuthPromptContent
                code={authCode}
                copied={copied}
                onCopy={copyCode}
                onCancel={() => {
                  onCloseAuthPrompt();
                  onCancelAuthentication();
                }}
              />
            </Popover>
          )}
        </div>
      </div>
    </div>
  );
}
