import type { DiffFileStatus, DiffScope } from '../types/vcs';

export interface ReviewScopeOption {
  scope: DiffScope;
  label: string;
  hint: string;
}

// Order shown in the Review tab's scope selector.
export const REVIEW_SCOPE_OPTIONS: ReviewScopeOption[] = [
  { scope: 'unstaged', label: 'Unstaged', hint: 'Working tree vs the index' },
  { scope: 'staged', label: 'Staged', hint: 'Index vs HEAD' },
  { scope: 'last_turn', label: 'Last turn', hint: "Since the agent's last turn began" },
  { scope: 'worktree', label: 'Worktree', hint: 'Everything since the base branch' },
  { scope: 'branch', label: 'Branch', hint: 'Committed work vs origin' },
  { scope: 'commit', label: 'Last commit', hint: 'The most recent commit' },
];

export function reviewScopeLabel(scope: DiffScope): string {
  return REVIEW_SCOPE_OPTIONS.find((o) => o.scope === scope)?.label ?? 'Changes';
}

const STATUS_SYMBOL: Record<DiffFileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  type: 'T',
  untracked: 'U',
};

export function fileStatusSymbol(status: DiffFileStatus): string {
  return STATUS_SYMBOL[status] ?? 'M';
}

export function fileStatusColor(status: DiffFileStatus): string {
  if (status === 'deleted') return 'var(--diff-del-fg)';
  if (status === 'added' || status === 'untracked') return 'var(--diff-add-fg)';
  if (status === 'renamed' || status === 'copied') return 'var(--droid-accent)';
  return 'var(--droid-text-secondary)';
}
