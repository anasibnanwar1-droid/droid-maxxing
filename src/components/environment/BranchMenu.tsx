import { useCallback, useMemo, useState } from 'react';
import { Check, ChevronDown, GitBranch, Loader2, Plus, Search, TriangleAlert } from 'lucide-react';
import { usePopover } from './usePopover';
import {
  checkoutGitBranch,
  createGitBranch,
  aheadBehindLabel,
  baseDescriptor,
} from '../../lib/git';
import { toast } from '../../lib/toast';
import type { GitActionResult, GitBranchList, GitEnvironment } from '../../types/vcs';

function BaseBadge({ env }: { env: GitEnvironment | null }) {
  const base = baseDescriptor(env);
  if (!base) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-droid-bg/60 px-1.5 py-0.5 text-[10px] text-droid-text-muted"
      title={`Based on ${base.ref} (${base.kind})`}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: base.kind === 'remote' ? '#3fb950' : '#848d97' }}
      />
      {base.shortName}
    </span>
  );
}

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
  const ref = usePopover<HTMLDivElement>(
    open,
    useCallback(() => setOpen(false), []),
  );
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirtyRef, setDirtyRef] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const current = env?.branch ?? null;

  const { local, remote } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (name: string) => !q || name.toLowerCase().includes(q);
    return {
      local: (branches?.local ?? []).filter((b) => match(b.name)),
      remote: (branches?.remote ?? []).filter((b) => match(b.name)).slice(0, 30),
    };
  }, [branches, query]);

  const finish = (res: GitActionResult, label: string) => {
    if (res.ok) {
      toast.success(`Switched to ${label}`);
      setOpen(false);
      setDirtyRef(null);
      onChanged();
    } else if (res.reason === 'dirty') {
      setDirtyRef(label);
    } else {
      toast.error(res.message || `Could not switch to ${label}`);
    }
  };

  const doCheckout = async (refName: string, allowDirty = false) => {
    if (live) {
      toast.error('Stop the agent before switching branches');
      return;
    }
    setBusy(true);
    const res = await checkoutGitBranch(cwd, { ref: refName, allowDirty });
    setBusy(false);
    finish(res, refName);
  };

  const doCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    if (live) {
      toast.error('Stop the agent before creating a branch');
      return;
    }
    setBusy(true);
    const res = await createGitBranch(cwd, { name, base: current ?? undefined, checkout: true });
    setBusy(false);
    if (res.ok) {
      toast.success(`Created and checked out ${name}`);
      setCreating(false);
      setNewName('');
      setOpen(false);
      onChanged();
    } else {
      toast.error(res.message || 'Could not create branch');
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
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
        <BaseBadge env={env} />
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-droid-text-muted/50 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute right-2 top-full z-50 mt-1 max-h-[420px] w-72 overflow-hidden rounded-xl border border-droid-border bg-droid-surface shadow-2xl shadow-black/50">
          <div className="flex items-center gap-2 border-b border-droid-border/70 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search branches"
              className="w-full bg-transparent text-[12.5px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
            />
            {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-droid-accent" />}
          </div>

          {dirtyRef && (
            <div className="flex items-center gap-2 bg-droid-orange/10 px-2.5 py-2 text-[11.5px] text-droid-text">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-droid-orange" />
              <span className="flex-1">Uncommitted changes.</span>
              <button
                onClick={() => doCheckout(dirtyRef, true)}
                className="rounded-md bg-droid-orange/20 px-2 py-0.5 text-[11px] font-medium text-droid-orange hover:bg-droid-orange/30"
              >
                Switch anyway
              </button>
            </div>
          )}

          <div className="max-h-[280px] overflow-y-auto py-1">
            <div className="px-2.5 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
              Branches
            </div>
            {local.map((b) => {
              const ab = aheadBehindLabel(b.ahead, b.behind);
              return (
                <button
                  key={b.name}
                  onClick={() => !b.current && doCheckout(b.name)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
                >
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text">
                    {b.name}
                  </span>
                  {ab && (
                    <span className="shrink-0 font-mono text-[10px] text-droid-text-muted">
                      {ab}
                    </span>
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

            {remote.length > 0 && (
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
                Remote
              </div>
            )}
            {remote.map((b) => {
              const localRef = b.name.split('/').slice(1).join('/') || b.name;
              return (
                <button
                  key={b.name}
                  onClick={() => doCheckout(localRef)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
                >
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-droid-text-muted/70" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text-secondary">
                    {b.name}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="border-t border-droid-border/70 p-1.5">
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
                  disabled={!newName.trim()}
                  className="shrink-0 rounded-md bg-droid-accent/15 px-2 py-1 text-[11px] font-medium text-droid-accent disabled:opacity-40"
                >
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
        </div>
      )}
    </div>
  );
}
