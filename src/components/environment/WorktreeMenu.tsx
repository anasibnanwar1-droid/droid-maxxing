import { useCallback, useState } from 'react';
import { Check, ChevronDown, Columns2, ExternalLink, Loader2, Plus } from 'lucide-react';
import { usePopover } from './usePopover';
import { useStore } from '../../hooks/useStore';
import { createGitWorktree, worktreeName } from '../../lib/git';
import { toast } from '../../lib/toast';
import type { GitBranchList, GitEnvironment, GitWorktree } from '../../types/vcs';

export function WorktreeMenu({
  cwd,
  env,
  worktrees,
  branches,
  onChanged,
}: {
  cwd: string;
  env: GitEnvironment | null;
  worktrees: GitWorktree[];
  branches: GitBranchList | null;
  onChanged: () => void;
}) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const ref = usePopover<HTMLDivElement>(
    open,
    useCallback(() => setOpen(false), []),
  );
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [base, setBase] = useState<string>(env?.branch ?? env?.defaultBranch ?? 'main');
  const [pickingBase, setPickingBase] = useState(false);
  const [busy, setBusy] = useState(false);

  const current = worktrees.find((w) => w.isCurrent);
  const others = worktrees.filter((w) => !w.isCurrent && !w.bare);

  const openInNewChat = (path: string) => {
    dispatch({ type: 'ADD_WORKSPACE', cwd: path });
    dispatch({ type: 'START_CHAT', cwd: path });
    setOpen(false);
  };

  const doCreate = async () => {
    const branch = name.trim();
    if (!branch) return;
    setBusy(true);
    const res = await createGitWorktree(cwd, { branch, base, newBranch: true });
    setBusy(false);
    if (res.ok && res.path) {
      toast.success(`Created worktree ${branch}`);
      setCreating(false);
      setName('');
      onChanged();
      openInNewChat(res.path);
    } else if (res.reason === 'exists') {
      toast.error('A worktree already exists at that path');
    } else {
      toast.error(res.message || 'Could not create worktree');
    }
  };

  const baseOptions = [
    ...(branches?.local ?? []).map((b) => b.name),
    ...(branches?.remote ?? []).map((b) => b.name),
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Worktrees"
        className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
          open ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
        }`}
      >
        <span className="shrink-0 text-droid-text-muted transition-colors group-hover:text-droid-text-secondary">
          <Columns2 className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-droid-text">
          {current ? worktreeName(current) : 'Worktree'}
          {env?.isLinkedWorktree && (
            <span className="ml-1.5 rounded bg-droid-accent/15 px-1 py-0.5 text-[9px] font-medium text-droid-accent">
              linked
            </span>
          )}
        </span>
        {worktrees.length > 1 && (
          <span className="shrink-0 font-mono text-[11px] text-droid-text-muted">
            {worktrees.length}
          </span>
        )}
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-droid-text-muted/50 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute right-2 top-full z-50 mt-1 w-72 overflow-hidden rounded-xl border border-droid-border bg-droid-surface shadow-2xl shadow-black/50">
          <div className="max-h-[260px] overflow-y-auto py-1">
            <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
              This session
            </div>
            {current && (
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <Check
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--droid-accent)' }}
                  strokeWidth={3}
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text">
                  {worktreeName(current)}
                </span>
                <span className="shrink-0 text-[10px] text-droid-text-muted">{current.head}</span>
              </div>
            )}

            {others.length > 0 && (
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
                Other worktrees
              </div>
            )}
            {others.map((w) => (
              <button
                key={w.path}
                onClick={() => w.path && openInNewChat(w.path)}
                title="Open this worktree in a new chat"
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
              >
                <Columns2 className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text-secondary">
                  {worktreeName(w)}
                </span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-droid-text-muted/60" />
              </button>
            ))}
          </div>

          <div className="border-t border-droid-border/70 p-1.5">
            {creating ? (
              <div className="space-y-1.5">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !pickingBase && void doCreate()}
                  placeholder="new-branch-name"
                  className="w-full rounded-md bg-droid-bg/60 px-2 py-1 text-[12px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
                />
                <button
                  onClick={() => setPickingBase((v) => !v)}
                  className="flex w-full items-center gap-1.5 rounded-md bg-droid-bg/40 px-2 py-1 text-[11.5px] text-droid-text-secondary hover:bg-droid-bg/60"
                >
                  <span className="text-droid-text-muted">Base</span>
                  <span className="flex-1 truncate text-left text-droid-text">{base}</span>
                  <ChevronDown
                    className={`h-3 w-3 transition-transform ${pickingBase ? 'rotate-180' : ''}`}
                  />
                </button>
                {pickingBase && (
                  <div className="max-h-32 overflow-y-auto rounded-md bg-droid-bg/40 p-1">
                    {baseOptions.map((option) => (
                      <button
                        key={option}
                        onClick={() => {
                          setBase(option);
                          setPickingBase(false);
                        }}
                        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11.5px] text-droid-text-secondary hover:bg-droid-elevated/60 hover:text-droid-text"
                      >
                        <span className="flex-1 truncate">{option}</span>
                        {option === base && (
                          <Check
                            className="h-3 w-3"
                            style={{ color: 'var(--droid-accent)' }}
                            strokeWidth={3}
                          />
                        )}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    onClick={() => setCreating(false)}
                    className="rounded-md px-2 py-1 text-[11px] text-droid-text-muted hover:text-droid-text"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void doCreate()}
                    disabled={!name.trim() || busy}
                    className="flex items-center gap-1 rounded-md bg-droid-accent/15 px-2 py-1 text-[11px] font-medium text-droid-accent disabled:opacity-40"
                  >
                    {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                    Create & open
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text transition-colors hover:bg-droid-elevated/60"
              >
                <Plus className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                New worktree…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
