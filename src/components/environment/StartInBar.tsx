import { useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Columns2,
  FolderPlus,
  Folders,
  GitBranch,
  Monitor,
} from 'lucide-react';
import { Popover } from './Popover';
import { StartBranchMenu } from './StartBranchMenu';
import { useStore } from '../../hooks/useStore';
import { useGitEnvironment } from '../../hooks/useGitEnvironment';
import { pickDirectory } from '../../lib/desktop';
import { worktreeName } from '../../lib/git';
import { workspaceName } from '../../lib/workspaces';

function Pill({
  icon,
  label,
  open,
  innerRef,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  open: boolean;
  innerRef: React.RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  return (
    <button
      ref={innerRef}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] transition-colors ${
        open
          ? 'bg-droid-bg/60 text-droid-text'
          : 'text-droid-text-secondary hover:bg-droid-bg/40 hover:text-droid-text'
      }`}
    >
      {icon}
      <span className="max-w-[150px] truncate">{label}</span>
      <ChevronDown
        className={`h-3 w-3 shrink-0 text-droid-text-muted/50 transition-transform ${open ? 'rotate-180' : ''}`}
      />
    </button>
  );
}

// The composer's "Start in" controls: pick the repo, the location (live checkout
// or a worktree) and the branch a brand-new chat runs in. Only shown while
// drafting, since a running session never hops worktrees.
export function StartInBar() {
  const { state, dispatch } = useStore();
  const draft = state.draftChat;
  const cwd = draft?.cwd ?? '';
  const { env, branches, worktrees, diffStat, refresh } = useGitEnvironment(cwd, 'worktree');

  const [repoOpen, setRepoOpen] = useState(false);
  const [locOpen, setLocOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const repoRef = useRef<HTMLButtonElement>(null);
  const locRef = useRef<HTMLButtonElement>(null);
  const branchRef = useRef<HTMLButtonElement>(null);

  if (!cwd) return null;

  const repoRoot = env?.repoRoot ?? cwd;
  const isRepo = !!env?.isRepo;
  const base = env?.branch ?? env?.defaultBranch ?? 'main';
  const localWorktrees = worktrees.filter((w) => !w.bare && w.path);
  const currentWt = localWorktrees.find((w) => w.path === cwd && w.path !== repoRoot);
  const onLocal = !currentWt;

  const startIn = (path: string, branch?: string) => {
    dispatch({ type: 'ADD_WORKSPACE', cwd: path });
    dispatch({ type: 'START_CHAT', cwd: path, branch });
  };

  const openFolder = async () => {
    setRepoOpen(false);
    const dir = await pickDirectory();
    if (dir) startIn(dir);
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Pill
        icon={<Folders className="h-3.5 w-3.5 shrink-0" />}
        label={workspaceName(repoRoot)}
        open={repoOpen}
        innerRef={repoRef}
        onClick={() => setRepoOpen((v) => !v)}
      />
      <Popover
        open={repoOpen}
        onClose={() => setRepoOpen(false)}
        anchorRef={repoRef}
        align="left"
        width={264}
      >
        <div className="max-h-[260px] overflow-y-auto py-1">
          {state.workspaceCwds.map((path) => (
            <button
              key={path}
              onClick={() => {
                startIn(path);
                setRepoOpen(false);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
            >
              <Folders className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-droid-text">
                  {workspaceName(path)}
                </span>
                <span className="block truncate text-[10.5px] text-droid-text-muted">{path}</span>
              </span>
              {path === repoRoot && (
                <Check
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--droid-accent)' }}
                  strokeWidth={3}
                />
              )}
            </button>
          ))}
        </div>
        <div className="border-t border-droid-border/70 p-1.5">
          <button
            onClick={() => void openFolder()}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text transition-colors hover:bg-droid-elevated/60"
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
            Open folder…
          </button>
        </div>
      </Popover>

      {isRepo && (
        <>
          <Pill
            icon={<Monitor className="h-3.5 w-3.5 shrink-0" />}
            label={currentWt ? worktreeName(currentWt) : 'Work locally'}
            open={locOpen}
            innerRef={locRef}
            onClick={() => setLocOpen((v) => !v)}
          />
          <Popover
            open={locOpen}
            onClose={() => setLocOpen(false)}
            anchorRef={locRef}
            align="left"
            width={280}
          >
            <div className="max-h-[260px] overflow-y-auto py-1">
              <button
                onClick={() => {
                  startIn(repoRoot);
                  setLocOpen(false);
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
              >
                <Monitor className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-droid-text">Work locally</span>
                  <span className="block truncate text-[10.5px] text-droid-text-muted">
                    {env?.branch ?? 'detached'} · current checkout
                  </span>
                </span>
                {onLocal && (
                  <Check
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--droid-accent)' }}
                    strokeWidth={3}
                  />
                )}
              </button>
              {localWorktrees
                .filter((w) => w.path !== repoRoot)
                .map((w) => (
                  <button
                    key={w.path}
                    onClick={() => {
                      if (w.path) startIn(w.path, w.branch ?? undefined);
                      setLocOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
                  >
                    <Columns2 className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text-secondary">
                      {worktreeName(w)}
                    </span>
                    {cwd === w.path && (
                      <Check
                        className="h-3.5 w-3.5 shrink-0"
                        style={{ color: 'var(--droid-accent)' }}
                        strokeWidth={3}
                      />
                    )}
                  </button>
                ))}
            </div>
          </Popover>

          <Pill
            icon={<GitBranch className="h-3.5 w-3.5 shrink-0" />}
            label={draft?.branch ?? env?.branch ?? 'detached'}
            open={branchOpen}
            innerRef={branchRef}
            onClick={() => setBranchOpen((v) => !v)}
          />
          <StartBranchMenu
            open={branchOpen}
            onClose={() => setBranchOpen(false)}
            anchorRef={branchRef}
            cwd={cwd}
            env={env}
            branches={branches}
            worktrees={worktrees}
            uncommittedFiles={diffStat?.files ?? 0}
            base={base}
            onStartIn={startIn}
            onRefresh={refresh}
          />
        </>
      )}
    </div>
  );
}
