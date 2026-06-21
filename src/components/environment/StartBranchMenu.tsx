import { useMemo, useState, type RefObject } from 'react';
import { Check, ChevronLeft, GitBranch, Loader2, Plus, Search } from 'lucide-react';
import { Popover } from './Popover';
import { checkoutGitBranch, createGitWorktree } from '../../lib/git';
import { toast } from '../../lib/toast';
import type { GitBranchList, GitEnvironment, GitWorktree } from '../../types/vcs';

function stripRemote(ref: string): string {
  const slash = ref.indexOf('/');
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

export function StartBranchMenu({
  open,
  onClose,
  anchorRef,
  cwd,
  env,
  branches,
  worktrees,
  uncommittedFiles,
  base,
  onStartIn,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
  cwd: string;
  env: GitEnvironment | null;
  branches: GitBranchList | null;
  worktrees: GitWorktree[];
  uncommittedFiles: number;
  base: string;
  onStartIn: (path: string, branch?: string) => void;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<{ branch: string; remote: boolean } | null>(null);
  const [path, setPath] = useState('');
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const repoRoot = env?.repoRoot ?? cwd;
  const current = env?.branch ?? null;

  const reset = () => {
    setPending(null);
    setCreatingNew(false);
    setNewName('');
    setQuery('');
  };
  const close = () => {
    reset();
    onClose();
  };

  const { locals, remotes } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const localNames = new Set((branches?.local ?? []).map((b) => b.name));
    const locals = (branches?.local ?? [])
      .filter((b) => !q || b.name.toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.name === current) return -1;
        if (b.name === current) return 1;
        return b.committerDate - a.committerDate;
      });
    const remotes = (branches?.remote ?? [])
      .filter((r) => !localNames.has(stripRemote(r.name)))
      .filter((r) => !q || r.name.toLowerCase().includes(q));
    return { locals, remotes };
  }, [branches, query, current]);

  const worktreeFor = (branch: string) =>
    worktrees.find((w) => w.branch === branch && w.path && !w.bare);

  const pickBranch = (branch: string, remote: boolean) => {
    const wt = worktreeFor(branch);
    if (wt?.path) {
      onStartIn(wt.path, branch);
      close();
      return;
    }
    setPending({ branch, remote });
    setPath(`${repoRoot}/.worktrees/${branch.replace(/[^\w.-]+/g, '-')}`);
  };

  const confirmCreate = async () => {
    if (!pending) return;
    setBusy(true);
    const localName = pending.remote ? stripRemote(pending.branch) : pending.branch;
    const res = await createGitWorktree(cwd, {
      branch: localName,
      base: pending.remote ? `origin/${stripRemote(pending.branch)}` : undefined,
      newBranch: pending.remote,
      location: path.trim() || undefined,
    });
    setBusy(false);
    if (res.ok && res.path) {
      toast.success(`Worktree ready on ${localName}`);
      onStartIn(res.path, localName);
      onRefresh();
      close();
    } else if (res.reason === 'exists') {
      toast.error('A worktree already exists at that path');
    } else {
      toast.error(res.message || 'Could not create worktree');
    }
  };

  const checkoutLocally = async () => {
    if (!pending) return;
    setBusy(true);
    const res = await checkoutGitBranch(cwd, { ref: pending.branch });
    setBusy(false);
    if (res.ok) {
      onStartIn(repoRoot, stripRemote(pending.branch));
      onRefresh();
      close();
    } else if (res.reason === 'dirty') {
      toast.error('Commit or stash your changes before checking out locally');
    } else {
      toast.error(res.message || 'Could not checkout');
    }
  };

  const createNewBranch = async () => {
    const branch = newName.trim();
    if (!branch) return;
    setBusy(true);
    const res = await createGitWorktree(cwd, { branch, base, newBranch: true });
    setBusy(false);
    if (res.ok && res.path) {
      toast.success(`Worktree ready on ${branch}`);
      onStartIn(res.path, branch);
      onRefresh();
      close();
    } else if (res.reason === 'exists') {
      toast.error('A worktree already exists at that path');
    } else {
      toast.error(res.message || 'Could not create worktree');
    }
  };

  return (
    <Popover open={open} onClose={close} anchorRef={anchorRef} align="left" width={320}>
      {pending ? (
        <div className="p-2.5">
          <button
            onClick={() => setPending(null)}
            className="mb-2 flex items-center gap-1 text-[11.5px] text-droid-text-muted hover:text-droid-text"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Branches
          </button>
          <div className="mb-1 text-[12.5px] text-droid-text">
            <span className="font-medium">{pending.branch}</span> has no worktree
          </div>
          <div className="mb-2 text-[11px] text-droid-text-muted">
            A linked worktree keeps your current checkout untouched.
          </div>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            spellCheck={false}
            className="mb-2.5 w-full rounded-md bg-droid-bg/60 px-2 py-1.5 font-mono text-[11.5px] text-droid-text focus:outline-none"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              onClick={() => void checkoutLocally()}
              disabled={busy}
              className="rounded-md px-2 py-1 text-[11.5px] text-droid-text-secondary hover:bg-droid-elevated/60 hover:text-droid-text disabled:opacity-40"
            >
              Checkout locally
            </button>
            <button
              onClick={() => void confirmCreate()}
              disabled={busy}
              className="flex items-center gap-1 rounded-md bg-droid-accent/15 px-2.5 py-1 text-[11.5px] font-medium text-droid-accent hover:bg-droid-accent/25 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              Create worktree
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-droid-border/70 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search branches"
              className="w-full bg-transparent text-[12px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
            />
          </div>
          <div className="max-h-[280px] overflow-y-auto py-1">
            <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
              Branches
            </div>
            {locals.map((b) => (
              <button
                key={b.name}
                onClick={() => pickBranch(b.name, false)}
                className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-droid-text">{b.name}</span>
                  {b.name === current ? (
                    <span className="block truncate text-[10.5px] text-droid-text-muted">
                      {uncommittedFiles > 0
                        ? `Uncommitted: ${uncommittedFiles} file${uncommittedFiles === 1 ? '' : 's'}`
                        : 'No uncommitted changes'}
                    </span>
                  ) : (
                    b.subject && (
                      <span className="block truncate text-[10.5px] text-droid-text-muted">
                        {b.subject}
                      </span>
                    )
                  )}
                </span>
                {b.name === current && (
                  <Check
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--droid-accent)' }}
                    strokeWidth={3}
                  />
                )}
              </button>
            ))}

            {remotes.length > 0 && (
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
                Remote
              </div>
            )}
            {remotes.map((r) => (
              <button
                key={r.name}
                onClick={() => pickBranch(r.name, true)}
                className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/60"
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text-secondary">
                  {r.name}
                </span>
              </button>
            ))}

            {locals.length === 0 && remotes.length === 0 && (
              <div className="px-2.5 py-2 text-[12px] text-droid-text-muted">No branches match</div>
            )}
          </div>

          <div className="border-t border-droid-border/70 p-1.5">
            {creatingNew ? (
              <div className="space-y-1.5">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void createNewBranch()}
                  placeholder="new-branch-name"
                  className="w-full rounded-md bg-droid-bg/60 px-2 py-1 text-[12px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
                />
                <div className="px-0.5 text-[10.5px] text-droid-text-muted">
                  Branches off <span className="text-droid-text-secondary">{base}</span>
                </div>
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    onClick={() => setCreatingNew(false)}
                    className="rounded-md px-2 py-1 text-[11px] text-droid-text-muted hover:text-droid-text"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void createNewBranch()}
                    disabled={!newName.trim() || busy}
                    className="flex items-center gap-1 rounded-md bg-droid-accent/15 px-2 py-1 text-[11px] font-medium text-droid-accent disabled:opacity-40"
                  >
                    {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                    Create & start
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setCreatingNew(true)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text transition-colors hover:bg-droid-elevated/60"
              >
                <Plus className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
                Create and checkout new branch…
              </button>
            )}
          </div>
        </>
      )}
    </Popover>
  );
}
