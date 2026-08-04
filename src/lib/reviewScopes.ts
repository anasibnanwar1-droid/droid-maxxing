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

// Scopes a Review focus request walks through when the clicked file is absent
// from the current scope's list. A changes-summary click targets 'last_turn',
// but that baseline only covers the latest turn: once a newer turn starts (or
// the app restarted and no baseline exists) the file drops out of the list.
// Falling through to broader scopes still lands the user on the file's current
// diff instead of leaving them on an unrelated file list.
const REVIEW_FOCUS_SCOPE_CHAIN: DiffScope[] = ['last_turn', 'uncommitted', 'worktree'];

// The next scope to try for a focus request, or null when the chain is
// exhausted (or the current scope is not part of the chain, e.g. the user
// manually switched scopes mid-flight).
export function nextReviewFocusScope(scope: DiffScope): DiffScope | null {
  const index = REVIEW_FOCUS_SCOPE_CHAIN.indexOf(scope);
  return index >= 0 && index < REVIEW_FOCUS_SCOPE_CHAIN.length - 1
    ? REVIEW_FOCUS_SCOPE_CHAIN[index + 1]
    : null;
}

// The most specific suffix match for an absolute path: the longest git path
// it ends with. A longer match pins the repo root more precisely, which
// decides between nested duplicates like "web/src/app.ts" versus
// "packages/web/src/app.ts".
function longestSuffixMatch(files: readonly { path: string }[], absPath: string): string | null {
  let best: string | null = null;
  for (const file of files) {
    if (absPath.endsWith(`/${file.path}`) && (best === null || file.path.length > best.length)) {
      best = file.path;
    }
  }
  return best;
}

// Match a focus-request path against a git diff file list. Focus paths come
// from transcript edits and may be absolute, repo-root-relative, or relative
// to the session cwd (which can be a repo subdirectory); git paths are always
// repo-root-relative. Edit tools resolve relative paths against the session
// cwd, so a relative focus path is tried in its cwd-resolved absolute form
// first: that pins the repo root and collapses duplicate suffixes
// (packages/a/src/app.ts vs packages/b/src/app.ts) to a single match. Exact
// matches come next, then suffix matches — longest-first for absolute paths,
// first match for the bare relative form, which carries no disambiguating
// prefix.
export function matchReviewFocusPath(
  files: readonly { path: string }[],
  focusPath: string,
  cwd?: string,
): string | null {
  const norm = focusPath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (!norm) return null;
  const isAbsolute = norm.startsWith('/') || /^[A-Za-z]:\//.test(norm);
  if (!isAbsolute && cwd) {
    const resolved = `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${norm}`;
    const match = longestSuffixMatch(files, resolved);
    if (match) return match;
  }
  for (const file of files) {
    if (file.path === focusPath || file.path === norm) return file.path;
  }
  if (isAbsolute) return longestSuffixMatch(files, norm);
  for (const file of files) {
    if (norm.endsWith(`/${file.path}`) || file.path.endsWith(`/${norm}`)) return file.path;
  }
  return null;
}
