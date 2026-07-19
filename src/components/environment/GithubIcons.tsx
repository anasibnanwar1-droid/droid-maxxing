import {
  Circle,
  CircleCheck,
  CircleX,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CheckStatus, PrKind } from '../../lib/github';

interface IconProps {
  size?: number;
  className?: string;
}

export const GitCommitIcon = ({ size = 16, className }: IconProps) => (
  <GitCommitHorizontal size={size} className={className} aria-hidden />
);

export const GitPullRequestIcon = ({ size = 16, className }: IconProps) => (
  <GitPullRequest size={size} className={className} aria-hidden />
);

// GitHub's PR-state palette. Open/closed reuse the shared diff green/red so the
// whole app speaks one color language; merged/draft keep GitHub's purple/gray.
const PR_STATES: Record<PrKind, { icon: LucideIcon; label: string; color: string }> = {
  open: { icon: GitPullRequest, label: 'Open', color: 'var(--diff-add-fg)' },
  draft: { icon: GitPullRequestDraft, label: 'Draft', color: '#848d97' },
  merged: { icon: GitMerge, label: 'Merged', color: '#a371f7' },
  closed: { icon: GitPullRequestClosed, label: 'Closed', color: 'var(--diff-del-fg)' },
};

export function PrStateIcon({ kind, size = 16 }: { kind: PrKind; size?: number }) {
  const { icon: Icon, label, color } = PR_STATES[kind];
  return (
    <span style={{ color }} title={label}>
      <Icon size={size} role="img" aria-label={label} />
    </span>
  );
}

const CHECK_STATES: Record<CheckStatus, { icon: LucideIcon; label: string; color: string }> = {
  success: { icon: CircleCheck, label: 'Passed', color: 'var(--diff-add-fg)' },
  failure: { icon: CircleX, label: 'Failed', color: 'var(--diff-del-fg)' },
  pending: { icon: Circle, label: 'Pending', color: '#d29922' },
  neutral: { icon: Circle, label: 'Neutral', color: '#848d97' },
};

export function CheckStatusIcon({ status, size = 14 }: { status: CheckStatus; size?: number }) {
  const { icon: Icon, label, color } = CHECK_STATES[status];
  const dot = Icon === Circle;
  return (
    <span style={{ color }} title={label}>
      <Icon
        size={dot ? size - 4 : size}
        fill={dot ? 'currentColor' : 'none'}
        role="img"
        aria-label={label}
      />
    </span>
  );
}
