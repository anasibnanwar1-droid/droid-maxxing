import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Columns2, ExternalLink, Loader2, Plus, Trash2, X } from 'lucide-react';
import { Popover } from './Popover';
import { useStore } from '../../hooks/useStore';
import { createGitWorktree, isWorktreeInUse, removeGitWorktree, worktreeName } from '../../lib/git';
import { activeSessionCwds } from '../../lib/missions';
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
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const defaultBase = env?.branch ?? env?.defaultBranch ?? 'main';
  const [base, setBase] = useState<string>(defaultBase);
  const [pickingBase, setPickingBase] = useState(false);
  const [busy, setBusy] = useState(false);
  // Synchronous re-entry guard: `busy` state only updates on the next render, so
  // a second Enter fired in the same tick (the input's keydown isn't disabled)
  // would slip past a `busy` check and launch a duplicate git operation.
  const busyRef = useRef(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  // Reset transient menu state when it closes so reopening never shows a stale
  // confirm affordance or a half-filled create form from the previous open.
  useEffect(() => {
    if (open) return;
    setConfirming(null);
    setCreating(false);
    setName('');
    setPickingBase(false);
  }, [open]);

  // The create form is opened on demand; seed its base from the current branch
  // each time so a useState-once default doesn't go stale after branch changes.
  const startCreating = () => {
    setBase(defaultBase);
    setCreating(true);
  };

  const current = worktrees.find((w) => w.isCurrent);
  const others = worktrees.filter((w) => !w.isCurrent && !w.bare && w.path);
  const sessionCwds = useMemo(
    () =>
      activeSessionCwds({
        missions: Object.values(state.missions),
        activeMissionId: state.activeMissionId,
        draftCwd: state.draftChat?.cwd,
        workers: state.workers,
      }),
    [state.missions, state.activeMissionId, state.draftChat?.cwd, state.workers],
  );

  const openInNewChat = (path: string, branch?: string | null) => {
    dispatch({ type: 'START_CHAT', cwd: path, branch: branch ?? undefined });
    setOpen(false);
  };

  const removeWorktree = async (path: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setRemoving(path);
    try {
      const res = await removeGitWorktree(cwd, { path });
      if (res.ok) {
        toast.success('Worktree removed');
        onChanged();
      } else if (
        res.reason === 'git_error' &&
        /not.*clean|dirty|contains modified/i.test(res.message ?? '')
      ) {
        toast.error('Worktree has changes — commit or discard first');
      } else {
        toast.error(res.message || 'Could not remove worktree');
      }
    } catch {
      toast.error('Could not remove worktree');
    } finally {
      busyRef.current = false;
      setBusy(false);
      setRemoving(null);
    }
  };

  const doCreate = async () => {
    const branch = name.trim();
    if (!branch || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await createGitWorktree(cwd, { branch, base, newBranch: true });
      if (res.ok && res.path) {
        toast.success(`Created worktree ${branch}`);
        setCreating(false);
        setName('');
        onChanged();
        openInNewChat(res.path, res.branch ?? branch);
      } else if (res.reason === 'exists') {
        toast.error('A worktree already exists at that path');
      } else {
        toast.error(res.message || 'Could not create worktree');
      }
    } catch {
      toast.error('Could not create worktree');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const baseOptions = useMemo(
    () => [
      ...(branches?.local ?? []).map((b) => b.name),
      ...(branches?.remote ?? []).map((b) => b.name),
    ],
    [branches],
  );

  return (
    <>
      <button
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
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

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        label="Worktrees"
        align="right"
        width={288}
      >
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
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
            <div
              key={w.path}
              className="group flex items-center gap-2 px-2.5 py-1.5 transition-colors hover:bg-droid-elevated/60"
            >
              <button
                onClick={() => w.path && openInNewChat(w.path, w.branch)}
                title="Open this worktree in a new chat"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Columns2 className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text-secondary">
                  {worktreeName(w)}
                </span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-droid-text-muted/60" />
              </button>
              {w.isMain ? (
                <span
                  title="The repository's main worktree can't be removed"
                  className="shrink-0 rounded bg-droid-elevated px-1.5 py-0.5 text-[10px] text-droid-text-muted"
                >
                  main
                </span>
              ) : w.path && isWorktreeInUse(w.path, sessionCwds) ? (
                <span
                  title="A chat is currently using this worktree"
                  className="shrink-0 rounded bg-droid-elevated px-1.5 py-0.5 text-[10px] text-droid-text-muted"
                >
                  in use
                </span>
              ) : removing === w.path ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-droid-text-muted" />
              ) : confirming === w.path ? (
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    onClick={() => {
                      setConfirming(null);
                      if (w.path) void removeWorktree(w.path);
                    }}
                    title="Confirm removal"
                    className="rounded p-1 text-droid-orange hover:bg-droid-orange/15"
                  >
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    title="Cancel"
                    className="rounded p-1 text-droid-text-muted hover:bg-droid-elevated"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => w.path && setConfirming(w.path)}
                  title="Remove worktree"
                  className="shrink-0 rounded p-1 text-droid-text-muted/0 transition-colors group-hover:text-droid-text-muted hover:!text-droid-orange"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="shrink-0 border-t border-droid-border/70 p-1.5">
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
              onClick={startCreating}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text transition-colors hover:bg-droid-elevated/60"
            >
              <Plus className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
              New worktree…
            </button>
          )}
        </div>
      </Popover>
    </>
  );
}
