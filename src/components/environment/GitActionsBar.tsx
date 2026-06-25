import { useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { GitCommitIcon, GitPullRequestIcon } from './GithubIcons';
import { CommitSheet } from './CommitSheet';
import { CreatePrSheet } from './CreatePrSheet';
import { gitPush } from '../../lib/git';
import { toast } from '../../lib/toast';
import type { GitBranchList, GitEnvironment } from '../../types/vcs';

type Sheet = 'none' | 'commit' | 'pr';

function ActionButton({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'bg-droid-elevated text-droid-text'
          : 'text-droid-text-secondary hover:bg-droid-elevated/60 hover:text-droid-text'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function GitActionsBar({
  cwd,
  env,
  branches,
  isGitHub,
  hasPr,
  onChanged,
  onPrCreated,
}: {
  cwd: string;
  env: GitEnvironment | null;
  branches: GitBranchList | null;
  isGitHub: boolean;
  hasPr: boolean;
  onChanged: () => void;
  onPrCreated?: () => void;
}) {
  const [sheet, setSheet] = useState<Sheet>('none');
  const [pushing, setPushing] = useState(false);

  const toggle = (next: Sheet) => setSheet((cur) => (cur === next ? 'none' : next));

  const doPush = async () => {
    setPushing(true);
    const res = await gitPush(cwd, { setUpstream: !env?.upstream });
    setPushing(false);
    if (res.ok) toast.success('Pushed to remote');
    else if (res.reason === 'detached') toast.error('Detached HEAD — checkout a branch first');
    else toast.error(res.message || 'Push failed');
    onChanged();
  };

  // Only commits ahead of upstream are publishable; a behind-only branch has
  // nothing to push, so the label must not surface the behind count.
  const aheadCount = env?.ahead ?? 0;

  return (
    <div className="px-1.5 pt-1">
      <div className="flex items-center gap-1">
        <ActionButton
          icon={<GitCommitIcon size={14} />}
          label="Commit"
          active={sheet === 'commit'}
          onClick={() => toggle('commit')}
        />
        <ActionButton
          icon={
            pushing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )
          }
          label={aheadCount > 0 ? `Push ↑${aheadCount}` : 'Push'}
          disabled={pushing || !!env?.detached}
          onClick={() => void doPush()}
        />
        {isGitHub && !hasPr && (
          <ActionButton
            icon={<GitPullRequestIcon size={14} />}
            label="Open PR"
            active={sheet === 'pr'}
            onClick={() => toggle('pr')}
          />
        )}
      </div>

      {sheet === 'commit' && (
        <div className="pt-1.5">
          <CommitSheet
            cwd={cwd}
            onDone={() => {
              setSheet('none');
              onChanged();
            }}
          />
        </div>
      )}
      {sheet === 'pr' && (
        <div className="pt-1.5">
          <CreatePrSheet
            cwd={cwd}
            env={env}
            branches={branches}
            onCreated={onPrCreated}
            onDone={() => {
              setSheet('none');
              onChanged();
            }}
          />
        </div>
      )}
    </div>
  );
}
