import { useCallback, useState } from 'react';
import { Check, ChevronDown, Columns2, FolderGit, Loader2, Plus } from 'lucide-react';
import { usePopover } from './usePopover';
import { useStore } from '../../hooks/useStore';
import { useGitEnvironment } from '../../hooks/useGitEnvironment';
import { createGitWorktree, worktreeName } from '../../lib/git';
import { toast } from '../../lib/toast';

// Lets a brand-new chat choose where it runs: the live checkout, an existing
// worktree, or a fresh worktree on a new branch. A running session never hops
// worktrees, so this only appears while drafting (no active session yet).
export function StartInPicker() {
  const { state, dispatch } = useStore();
  const draft = state.draftChat;
  const cwd = draft?.cwd ?? '';
  const { env, worktrees } = useGitEnvironment(cwd, 'worktree');
  const [open, setOpen] = useState(false);
  const ref = usePopover<HTMLDivElement>(
    open,
    useCallback(() => setOpen(false), []),
  );
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  if (!cwd || !env?.isRepo) return null;

  const repoRoot = env.repoRoot ?? cwd;
  const base = env.branch ?? env.defaultBranch ?? 'main';
  const others = worktrees.filter((w) => !w.bare && w.path && w.path !== draft?.cwd);
  const onLocal = !draft?.branch;

  const startIn = (path: string, branch?: string) => {
    dispatch({ type: 'ADD_WORKSPACE', cwd: path });
    dispatch({ type: 'START_CHAT', cwd: path, branch });
    setOpen(false);
  };

  const doCreate = async () => {
    const branch = name.trim();
    if (!branch) return;
    setBusy(true);
    const res = await createGitWorktree(cwd, { branch, base, newBranch: true });
    setBusy(false);
    if (res.ok && res.path) {
      toast.success(`Worktree ready on ${branch}`);
      setCreating(false);
      setName('');
      startIn(res.path, branch);
    } else if (res.reason === 'exists') {
      toast.error('A worktree already exists at that path');
    } else {
      toast.error(res.message || 'Could not create worktree');
    }
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Where this chat runs"
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] transition-colors ${
          open
            ? 'bg-droid-bg/60 text-droid-text'
            : 'text-droid-text-secondary hover:bg-droid-bg/40 hover:text-droid-text'
        }`}
      >
        {draft?.branch ? (
          <Columns2 className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <FolderGit className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="max-w-[160px] truncate">{draft?.branch ?? 'Local'}</span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-droid-text-muted/50 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1.5 w-72 overflow-hidden rounded-xl border border-droid-border bg-droid-surface shadow-2xl shadow-black/50">
          <div className="max-h-[260px] overflow-y-auto py-1">
            <button
              onClick={() => startIn(repoRoot)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
            >
              <FolderGit className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-droid-text">Work locally</span>
                <span className="block truncate text-[10.5px] text-droid-text-muted">
                  {env.branch ?? 'detached'} · current checkout
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

            {others.length > 0 && (
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
                Existing worktrees
              </div>
            )}
            {others.map((w) => (
              <button
                key={w.path}
                onClick={() => w.path && startIn(w.path, w.branch ?? undefined)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
              >
                <Columns2 className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text-secondary">
                  {worktreeName(w)}
                </span>
                {draft?.cwd === w.path && (
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
            {creating ? (
              <div className="space-y-1.5">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void doCreate()}
                  placeholder="new-branch-name"
                  className="w-full rounded-md bg-droid-bg/60 px-2 py-1 text-[12px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
                />
                <div className="px-0.5 text-[10.5px] text-droid-text-muted">
                  Branches off <span className="text-droid-text-secondary">{base}</span>
                </div>
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
                    Create & start
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
