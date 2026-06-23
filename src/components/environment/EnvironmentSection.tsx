import { ChevronRight, Folders } from 'lucide-react';
import { Row } from './primitives';
import { DiffStat } from './DiffStat';
import { BranchMenu } from './BranchMenu';
import { WorktreeMenu } from './WorktreeMenu';
import { GitActionsBar } from './GitActionsBar';
import { PrStateIcon } from './GithubIcons';
import { openCodebase } from '../EditorOpenMenu';
import { prKind } from '../../lib/github';
import type {
  DiffStatMode,
  GitBranchList,
  GitDiffStat,
  GitEnvironment,
  GitWorktree,
  PullRequest,
} from '../../types/vcs';

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

export function EnvironmentSection({
  cwd,
  env,
  branches,
  worktrees,
  diffStat,
  diffMode,
  onDiffModeChange,
  refresh,
  live,
  pr,
  onOpenPr,
  onOpenReview,
}: {
  cwd: string;
  env: GitEnvironment | null;
  branches: GitBranchList | null;
  worktrees: GitWorktree[];
  diffStat: GitDiffStat | null;
  diffMode: DiffStatMode;
  onDiffModeChange: (mode: DiffStatMode) => void;
  refresh: () => void;
  live: boolean;
  pr: PullRequest | null;
  onOpenPr: () => void;
  onOpenReview: () => void;
}) {
  const location = basename(env?.repoRoot ?? env?.worktreePath ?? cwd) || 'No folder';
  const isRepo = !!env?.isRepo;
  const isGitHub = !!env?.isGitHub;

  return (
    <div>
      <Row
        icon={<Folders className="h-4 w-4" />}
        label={location}
        title={env?.repoRoot ?? cwd}
        onClick={() => openCodebase(cwd)}
      />

      {!isRepo ? (
        <div className="px-3 py-1.5 text-[12px] text-droid-text-muted">Not a git repository</div>
      ) : (
        <>
          <BranchMenu cwd={cwd} env={env} branches={branches} live={live} onChanged={refresh} />
          <WorktreeMenu
            cwd={cwd}
            env={env}
            worktrees={worktrees}
            branches={branches}
            onChanged={refresh}
          />
          <DiffStat
            stat={diffStat}
            mode={diffMode}
            baseRef={env?.diffBaseRef ?? env?.defaultRef}
            onModeChange={onDiffModeChange}
            onOpenReview={onOpenReview}
          />
          <GitActionsBar
            cwd={cwd}
            env={env}
            branches={branches}
            isGitHub={isGitHub}
            hasPr={!!pr && (prKind(pr) === 'open' || prKind(pr) === 'draft')}
            onChanged={refresh}
          />

          {pr && (
            <Row
              icon={<PrStateIcon kind={prKind(pr)} size={16} />}
              label={`#${pr.number} ${pr.title}`}
              title={`${pr.title} — view checks and comments`}
              onClick={onOpenPr}
              trailing={<ChevronRight className="h-3.5 w-3.5 text-droid-text-muted" />}
            />
          )}
        </>
      )}
    </div>
  );
}
