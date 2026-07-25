import type { DiffScope, DiffStatMode } from '../types/vcs';

export interface ReviewScopeOption {
  scope: DiffScope;
  label: string;
  hint: string;
}

// Order shown in the Review tab's scope selector.
export const REVIEW_SCOPE_OPTIONS: ReviewScopeOption[] = [
  { scope: 'unstaged', label: 'Unstaged', hint: 'Working tree vs the index' },
  { scope: 'staged', label: 'Staged', hint: 'Index vs HEAD' },
  { scope: 'uncommitted', label: 'Uncommitted', hint: 'All changes since the last commit' },
  { scope: 'last_turn', label: 'Last turn', hint: "Since the agent's last turn began" },
  { scope: 'worktree', label: 'Worktree', hint: 'Everything since the base branch' },
  { scope: 'branch', label: 'Branch', hint: 'Committed work vs origin' },
  { scope: 'commit', label: 'Last commit', hint: 'The most recent commit' },
];

export function reviewScopeLabel(scope: DiffScope): string {
  return REVIEW_SCOPE_OPTIONS.find((o) => o.scope === scope)?.label ?? 'Changes';
}

// The review scope whose file list matches a Context-panel diff summary, so
// opening Review from a summary shows the same files. Each summary mode has an
// exactly-corresponding scope (the 'uncommitted' summary includes staged files).
export function diffModeToReviewScope(mode: DiffStatMode): DiffScope {
  if (mode === 'branch') return 'branch';
  if (mode === 'worktree') return 'worktree';
  return 'uncommitted';
}
