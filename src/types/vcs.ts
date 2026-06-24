// Shared VCS types mirrored from electron/git.cjs and electron/github.cjs.
// Pure type declarations only — no imports — so both the desktop bridge typing
// and the frontend helpers can depend on it without creating a cycle.

export type DiffStatMode = 'worktree' | 'branch' | 'uncommitted';

export type DiffScope = 'unstaged' | 'staged' | 'commit' | 'branch' | 'worktree' | 'last_turn';

export type DiffFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type'
  | 'untracked';

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffFileList {
  mode: DiffScope;
  base: string | null;
  files: DiffFile[];
}

export interface FileDiffResult {
  path: string | null;
  diff: string;
  binary: boolean;
}

export interface GitEnvironment {
  isRepo: boolean;
  repoRoot?: string | null;
  worktreePath?: string | null;
  isLinkedWorktree?: boolean;
  branch?: string | null;
  detached?: boolean;
  head?: string | null;
  upstream?: string | null;
  base?: string | null;
  baseKind?: 'local' | 'remote' | null;
  ahead?: number;
  behind?: number;
  defaultBranch?: string | null;
  defaultRef?: string | null;
  remoteUrl?: string | null;
  isGitHub?: boolean;
}

export interface GitBranch {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  current: boolean;
  committerDate: number;
  subject: string;
}

export interface GitBranchList {
  current: string | null;
  detached: boolean;
  local: GitBranch[];
  remote: { name: string }[];
}

export interface GitWorktree {
  path: string | null;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  isMain: boolean;
  isCurrent: boolean;
}

export interface GitDiffStat {
  mode: DiffStatMode;
  base: string | null;
  additions: number;
  deletions: number;
  files: number;
}

export interface GitActionResult {
  ok: boolean;
  reason?: string;
  message?: string;
  environment?: GitEnvironment;
  path?: string;
  branch?: string;
  head?: string | null;
  output?: string;
}

export interface CreateBranchOptions {
  name: string;
  base?: string;
  checkout?: boolean;
}

export interface CreateWorktreeOptions {
  branch: string;
  base?: string;
  newBranch?: boolean;
  location?: string;
}

export interface CommitOptions {
  message: string;
  all?: boolean;
}

export interface PushOptions {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  force?: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  isDraft: boolean;
  headRefName: string | null;
  baseRefName: string | null;
  mergeable: string | null;
  reviewDecision: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string | null;
  updatedAt: string | null;
  author: string | null;
}

export type PrCheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | string;

export interface PrCheck {
  name: string;
  workflow: string | null;
  bucket: PrCheckBucket;
  state: string;
  description: string;
  link: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PrChecksResult {
  ok: boolean;
  reason?: string;
  message?: string;
  checks: PrCheck[];
}

export interface PrComment {
  id: string;
  kind: 'comment' | 'review';
  author: string;
  body: string;
  createdAt: string | null;
  url: string | null;
  state: string | null;
}

export interface PrCommentsResult {
  ok: boolean;
  reason?: string;
  message?: string;
  comments: PrComment[];
}

export interface GithubAvailability {
  installed: boolean;
  authenticated: boolean;
}

export interface CreatePrOptions {
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
  head?: string;
}

export interface CreatePrResult {
  ok: boolean;
  reason?: string;
  message?: string;
  url?: string | null;
  number?: number | null;
  pr?: PullRequest | null;
}

export interface PostCommentResult {
  ok: boolean;
  reason?: string;
  message?: string;
  url?: string | null;
}
