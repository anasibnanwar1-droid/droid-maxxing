// Official GitHub Octicons (16px, MIT-licensed by GitHub) embedded as inline
// SVG paths so commit / pull-request / merged states use the real GitHub marks
// without adding a dependency. Matches the inline-SVG pattern of EditorIcon.
import type { CheckStatus, PrKind } from '../../lib/github';

interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

function Octicon({ size = 16, className, title, path }: IconProps & { path: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <path d={path} />
    </svg>
  );
}

export const GitCommitIcon = (props: IconProps) => (
  <Octicon
    {...props}
    path="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"
  />
);

export const GitPullRequestIcon = (props: IconProps) => (
  <Octicon
    {...props}
    path="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"
  />
);

const GitMergeIcon = (props: IconProps) => (
  <Octicon
    {...props}
    path="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"
  />
);

const GitPullRequestClosedIcon = (props: IconProps) => (
  <Octicon
    {...props}
    path="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
  />
);

const GitPullRequestDraftIcon = (props: IconProps) => (
  <Octicon
    {...props}
    path="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"
  />
);

const CheckCircleFillIcon = (props: IconProps) => (
  <Octicon
    {...props}
    path="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z"
  />
);

const XCircleFillIcon = (props: IconProps) => (
  <Octicon
    {...props}
    path="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z"
  />
);

const DotFillIcon = (props: IconProps) => (
  <Octicon {...props} path="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
);

// GitHub's PR-state palette. Open/closed reuse the shared diff green/red so the
// whole app speaks one color language; merged/draft keep GitHub's purple/gray.
const PR_COLORS: Record<PrKind, string> = {
  open: 'var(--diff-add-fg)',
  draft: '#848d97',
  merged: '#a371f7',
  closed: 'var(--diff-del-fg)',
};

export function PrStateIcon({ kind, size = 16 }: { kind: PrKind; size?: number }) {
  if (kind === 'merged')
    return (
      <span style={{ color: PR_COLORS.merged }}>
        <GitMergeIcon size={size} title="Merged" />
      </span>
    );
  if (kind === 'closed')
    return (
      <span style={{ color: PR_COLORS.closed }}>
        <GitPullRequestClosedIcon size={size} title="Closed" />
      </span>
    );
  if (kind === 'draft')
    return (
      <span style={{ color: PR_COLORS.draft }}>
        <GitPullRequestDraftIcon size={size} title="Draft" />
      </span>
    );
  return (
    <span style={{ color: PR_COLORS.open }}>
      <GitPullRequestIcon size={size} title="Open" />
    </span>
  );
}

const CHECK_COLORS: Record<CheckStatus, string> = {
  success: 'var(--diff-add-fg)',
  failure: 'var(--diff-del-fg)',
  pending: '#d29922',
  neutral: '#848d97',
};

export function CheckStatusIcon({ status, size = 14 }: { status: CheckStatus; size?: number }) {
  const color = CHECK_COLORS[status];
  const icon =
    status === 'success' ? (
      <CheckCircleFillIcon size={size} title="Passed" />
    ) : status === 'failure' ? (
      <XCircleFillIcon size={size} title="Failed" />
    ) : (
      <DotFillIcon size={size} title={status === 'pending' ? 'Pending' : 'Neutral'} />
    );
  return <span style={{ color }}>{icon}</span>;
}
