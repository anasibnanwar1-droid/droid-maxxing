import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, GitBranch, Loader2, Plus, Search, TriangleAlert } from 'lucide-react';
import { Popover } from './Popover';
import { checkoutGitBranch, createGitBranch, aheadBehindLabel } from '../../lib/git';
import { useGitFetchOnOpen } from '../../hooks/useGitFetchOnOpen';
import { toast } from '../../lib/toast';
import type { GitActionResult, GitBranchList, GitEnvironment } from '../../types/vcs';

export function BranchMenu({
  cwd,
  env,
  branches,
  live,
  onChanged,
}: {
  cwd: string;
  env: GitEnvironment | null;
  branches: GitBranchList | null;
  live: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  // Synchronous re-entry guard: `busy` state only updates on the next render, so
  // a same-tick second trigger (the create input's Enter isn't disabled) would
  // slip past a `busy` check and launch a duplicate git operation.
  const busyRef = useRef(false);
  const [dirtyRef, setDirtyRef] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const fetching = useGitFetchOnOpen(open, cwd, onChanged);

  const current = env?.branch ?? null;

  const { local, localOverflow, remote, remoteOverflow } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (name: string) => !q || name.toLowerCase().includes(q);
    const localAll = (branches?.local ?? []).filter((b) => match(b.name));
    const remoteAll = (branches?.remote ?? []).filter((b) => match(b.name));
    // Cap both lists the same way so a repo with hundreds of branches doesn't
    // mount hundreds of rows; a "more" hint surfaces the rest like the remote list.
    const MAX = 30;
    return {
      local: localAll.slice(0, MAX),
      localOverflow: Math.max(0, localAll.length - MAX),
      remote: remoteAll.slice(0, MAX),
      remoteOverflow: Math.max(0, remoteAll.length - MAX),
    };
  }, [branches, query]);

  const close = () => {
    setOpen(false);
    setDirtyRef(null);
    setQuery('');
    setCreating(false);
    setNewName('');
  };

  const finish = (res: GitActionResult, label: string) => {
    if (res.ok) {
      toast.success(`Switched to ${label}`);
      close();
      onChanged();
    } else if (res.reason === 'dirty') {
      setDirtyRef(label);
    } else {
      toast.error(res.message || `Could not switch to ${label}`);
    }
  };

  const doCheckout = async (refName: string, allowDirty = false) => {
    if (busyRef.current) return;
    if (live) {
      toast.error('Stop the agent before switching branches');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    // Clear the previous dirty prompt now: if this attempt fails with a
    // non-dirty error, a stale banner would otherwise offer "Switch anyway"
    // for the earlier branch, force-checking-out the wrong ref.
    setDirtyRef(null);
    try {
      const res = await checkoutGitBranch(cwd, { ref: refName, allowDirty });
      finish(res, refName);
    } catch {
      toast.error(`Could not switch to ${refName}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const doCreate = async () => {
    const name = newName.trim();
    if (!name || busyRef.current) return;
    if (live) {
      toast.error('Stop the agent before creating a branch');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await createGitBranch(cwd, { name, base: current ?? undefined, checkout: true });
      if (res.ok) {
        toast.success(`Created and checked out ${name}`);
        close();
        onChanged();
      } else {
        toast.error(res.message || 'Could not create branch');
      }
    } catch {
      toast.error('Could not create branch');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={anchorRef}
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={current ? `On branch ${current}` : 'Detached HEAD'}
        className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
          open ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
        }`}
      >
        <span className="shrink-0 text-droid-text-muted transition-colors group-hover:text-droid-text-secondary">
          <GitBranch className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] leading-snug text-droid-text">
          {current ?? 'Detached HEAD'}
        </span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-droid-text-muted/50 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <Popover
        open={open}
        onClose={close}
        anchorRef={anchorRef}
        label="Switch branch"
        align="right"
        width={288}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-droid-border/70 px-2.5 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search branches"
            className="w-full bg-transparent text-[12.5px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
          />
          {(busy || fetching) && (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-droid-accent" />
          )}
        </div>

        {dirtyRef && (
          <div className="flex items-center gap-2 bg-droid-orange/10 px-2.5 py-2 text-[11.5px] text-droid-text">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-droid-orange" />
            <span className="flex-1">Uncommitted changes.</span>
            <button
              onClick={() => doCheckout(dirtyRef, true)}
              disabled={busy}
              className="rounded-md bg-droid-orange/20 px-2 py-0.5 text-[11px] font-medium text-droid-orange hover:bg-droid-orange/30 disabled:opacity-40"
            >
              Switch anyway
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <div className="px-2.5 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
            Branches
          </div>
          {local.map((b) => {
            const ab = aheadBehindLabel(b.ahead, b.behind);
            return (
              <button
                key={b.name}
                onClick={() => {
                  if (busy || fetching || b.current) return;
                  doCheckout(b.name);
                }}
                aria-disabled={busy || fetching}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text">
                  {b.name}
                </span>
                {ab && (
                  <span className="shrink-0 font-mono text-[10px] text-droid-text-muted">{ab}</span>
                )}
                {b.current && (
                  <Check
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--droid-accent)' }}
                    strokeWidth={3}
                  />
                )}
              </button>
            );
          })}
          {localOverflow > 0 && (
            <div className="px-2.5 py-1.5 text-[11px] text-droid-text-muted">
              + {localOverflow} more, refine the search to see them
            </div>
          )}

          {remote.length > 0 && (
            <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
              Remote
            </div>
          )}
          {remote.map((b) => {
            return (
              <button
                key={b.name}
                onClick={() => {
                  if (busy || fetching) return;
                  doCheckout(b.name);
                }}
                aria-disabled={busy || fetching}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-droid-text-muted/70" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text-secondary">
                  {b.name}
                </span>
              </button>
            );
          })}
          {remoteOverflow > 0 && (
            <div className="px-2.5 py-1.5 text-[11px] text-droid-text-muted">
              + {remoteOverflow} more, refine the search to see them
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-droid-border/70 p-1.5">
          {creating ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void doCreate()}
                placeholder="new-branch-name"
                className="w-full rounded-md bg-droid-bg/60 px-2 py-1 text-[12px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
              />
              <button
                onClick={() => void doCreate()}
                disabled={!newName.trim() || busy}
                className="flex shrink-0 items-center gap-1 rounded-md bg-droid-accent/15 px-2 py-1 text-[11px] font-medium text-droid-accent disabled:opacity-40"
              >
                {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                Create
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text transition-colors hover:bg-droid-elevated/60"
            >
              <Plus className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
              Create and checkout new branch…
            </button>
          )}
        </div>
      </Popover>
    </>
  );
}
