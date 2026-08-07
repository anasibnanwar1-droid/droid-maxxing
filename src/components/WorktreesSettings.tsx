import {
  Check,
  Columns2,
  GitBranch,
  Loader2,
  MessageSquare,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../hooks/useStore';
import { reanchorSessionsForWorktreeRemoval } from '../lib/commands';
import {
  getGitBranches,
  getGitWorktrees,
  isWorktreeInUse,
  removeGitWorktree,
  worktreeName,
} from '../lib/git';
import { detectPullRequest } from '../lib/github';
import { activeSessionCwds } from '../lib/sessions';
import { toast } from '../lib/toast';
import { utilityTerminalCwds } from '../lib/utilityPanel';
import {
  linkedSessionsForWorktree,
  uniqueWorktreeRepositories,
  worktreeChatStatus,
} from '../lib/worktreeSettings';
import { workspaceName } from '../lib/workspaces';
import type { SessionSummary } from '../types/bridge';
import type { GitActionResult, GitBranchList, GitWorktree, PullRequest } from '../types/vcs';

interface WorktreeDetails {
  worktree: GitWorktree;
  pullRequest: PullRequest | null;
}

interface RepositoryWorktrees {
  root: string;
  name: string;
  branches: GitBranchList;
  worktrees: WorktreeDetails[];
}

function branchWasDeleted(result: GitActionResult): boolean {
  return 'branchDeleted' in result && result.branchDeleted === true;
}

function ChatStatus({
  session,
  activeAppSessionId,
}: {
  session: SessionSummary;
  activeAppSessionId: string | null;
}) {
  const label = worktreeChatStatus(session, activeAppSessionId);
  return (
    <span className="rounded bg-droid-elevated px-1.5 py-0.5 text-[10px] text-droid-text-muted">
      {label}
    </span>
  );
}

function WorktreeAction({
  worktree,
  isInUse,
  isConfirming,
  removing,
  onConfirm,
  onCancel,
  onRemove,
}: {
  worktree: GitWorktree;
  isInUse: boolean;
  isConfirming: boolean;
  removing: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  if (worktree.isMain) return null;
  if (isInUse) {
    return (
      <span
        title="An open or working chat is using this worktree"
        className="shrink-0 rounded bg-droid-elevated px-1.5 py-0.5 text-[10px] text-droid-text-muted"
      >
        in use
      </span>
    );
  }
  if (isConfirming) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={onRemove}
          disabled={removing !== null}
          title="Confirm removal"
          className="rounded p-1.5 text-red-400 hover:bg-droid-elevated disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </button>
        <button
          onClick={onCancel}
          className="rounded px-1.5 py-1 text-[11px] text-droid-text-muted hover:bg-droid-elevated"
        >
          Cancel
        </button>
      </div>
    );
  }
  return (
    <button
      onClick={onConfirm}
      disabled={removing !== null}
      title="Remove worktree"
      className="rounded-md p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-red-400 disabled:opacity-40"
    >
      {removing === worktree.path ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Trash2 className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function WorktreeRow({
  details,
  linkedSessions,
  activeAppSessionId,
  isMerged,
  isInUse,
  isConfirming,
  removing,
  onConfirm,
  onCancel,
  onRemove,
  onOpenChat,
}: {
  details: WorktreeDetails;
  linkedSessions: SessionSummary[];
  activeAppSessionId: string | null;
  isMerged: boolean;
  isInUse: boolean;
  isConfirming: boolean;
  removing: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onOpenChat: (appSessionId: string) => void;
}) {
  const { worktree, pullRequest } = details;
  const chatMoveNotice =
    linkedSessions.length > 0
      ? `${String(linkedSessions.length)} idle ${linkedSessions.length === 1 ? 'chat' : 'chats'} will move to main. `
      : '';
  return (
    <div className="px-3 py-3">
      <div className="flex items-start gap-2.5">
        <Columns2 className="mt-0.5 h-4 w-4 shrink-0 text-droid-text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <GitBranch className="h-3 w-3 shrink-0 text-droid-text-muted" />
            <span className="truncate text-[12.5px] text-droid-text">{worktreeName(worktree)}</span>
            <span className="rounded bg-droid-elevated px-1.5 py-0.5 text-[10px] text-droid-text-muted">
              {worktree.isMain ? 'main checkout' : 'linked worktree'}
            </span>
            {isMerged && (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">
                merged
              </span>
            )}
            {pullRequest && (
              <span className="rounded bg-droid-accent/10 px-1.5 py-0.5 text-[10px] text-droid-accent">
                PR #{pullRequest.number}{' '}
                {pullRequest.isDraft ? 'draft' : pullRequest.state.toLowerCase()}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-droid-text-muted">{worktree.path}</div>
        </div>
        <WorktreeAction
          worktree={worktree}
          isInUse={isInUse}
          isConfirming={isConfirming}
          removing={removing}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onRemove={onRemove}
        />
      </div>

      {isConfirming && !isInUse && (
        <p className="ml-6 mt-2 text-[11px] text-droid-text-muted">
          {chatMoveNotice}
          {isMerged
            ? 'Git will delete the merged local branch.'
            : 'The local branch will be kept unless Git confirms it is merged.'}
        </p>
      )}

      {linkedSessions.length > 0 && (
        <div className="ml-6 mt-2 border-l border-droid-border pl-2.5">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
            Linked chats
          </div>
          <div className="space-y-0.5">
            {linkedSessions.map((session) => (
              <button
                key={session.appSessionId}
                onClick={() => {
                  onOpenChat(session.appSessionId);
                }}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-droid-elevated/60"
              >
                <MessageSquare className="h-3 w-3 shrink-0 text-droid-text-muted" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-droid-text-secondary">
                  {session.title}
                </span>
                <ChatStatus session={session} activeAppSessionId={activeAppSessionId} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function WorktreesSettings() {
  const { state, dispatch } = useStore();
  const [repositories, setRepositories] = useState<RepositoryWorktrees[]>([]);
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const loadRequest = useRef(0);
  const removingRef = useRef(false);
  const sessions = useMemo(() => Object.values(state.sessions), [state.sessions]);

  const load = useCallback(async () => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    const next: RepositoryWorktrees[] = [];
    const candidates = await Promise.all(
      state.workspaceCwds.map(async (cwd) => ({ cwd, worktrees: await getGitWorktrees(cwd) })),
    );
    for (const candidate of uniqueWorktreeRepositories(candidates)) {
      const { root } = candidate;
      const worktrees = candidate.worktrees.filter((worktree) => !worktree.bare && worktree.path);
      if (!worktrees.some((worktree) => !worktree.isMain)) continue;
      const branches = await getGitBranches(root);
      const details = await Promise.all(
        worktrees.map(async (worktree): Promise<WorktreeDetails> => {
          if (worktree.isMain || !worktree.path || !worktree.branch) {
            return { worktree, pullRequest: null };
          }
          const detected = await detectPullRequest(worktree.path, worktree.branch);
          return { worktree, pullRequest: detected.ok ? detected.pr : null };
        }),
      );
      next.push({ root, name: workspaceName(root), branches, worktrees: details });
    }
    if (requestId !== loadRequest.current) return;
    setRepositories(next);
    setLoading(false);
  }, [state.workspaceCwds]);

  useEffect(() => {
    void load();
  }, [load]);

  const sessionCwds = activeSessionCwds({
    sessions,
    activeAppSessionId: state.activeAppSessionId,
    draftCwd: state.draftChat?.cwd,
    childSessions: state.childSessions,
    childRuntime: state.childRuntime,
    pinnedCwds: utilityTerminalCwds(
      state.utilityPanels,
      Object.fromEntries(sessions.map((session) => [session.appSessionId, session.cwd])),
    ),
  });

  const remove = async (repository: RepositoryWorktrees, details: WorktreeDetails) => {
    const path = details.worktree.path;
    if (!path || removingRef.current) return;
    removingRef.current = true;
    setRemoving(path);
    try {
      const reanchored = await reanchorSessionsForWorktreeRemoval(path, repository.root);
      const options = { path, deleteBranch: true };
      const result = await removeGitWorktree(repository.root, options);
      if (!result.ok) {
        if (
          result.reason === 'not_clean' ||
          /not.*clean|dirty|contains modified/i.test(result.message ?? '')
        ) {
          toast.error('Has uncommitted changes — commit or discard them first');
        } else {
          toast.error(result.message ?? 'Could not remove worktree');
        }
        return;
      }
      const outcomes = ['Worktree removed'];
      if (reanchored > 0) {
        const chats = reanchored === 1 ? 'chat' : 'chats';
        outcomes.push(`${String(reanchored)} ${chats} moved to main`);
      }
      if (branchWasDeleted(result)) outcomes.push('merged branch deleted');
      toast.success(outcomes.join('; '));
      if (details.worktree.branch && !branchWasDeleted(result)) {
        toast.info('Local branch kept because Git did not confirm it was safe to delete');
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not prepare worktree removal');
    } finally {
      removingRef.current = false;
      setRemoving(null);
    }
  };

  const linkedCount = repositories.reduce(
    (count, repository) =>
      count + repository.worktrees.filter(({ worktree }) => !worktree.isMain).length,
    0,
  );

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-droid-text">Worktrees</h2>
          <p className="mt-0.5 text-[12px] text-droid-text-muted">
            See each workspace, its linked chats, branch status, and pull request before cleanup.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-droid-border px-2.5 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {linkedCount === 0 ? (
        <div className="rounded-xl border border-dashed border-droid-border bg-droid-surface/40 p-10 text-center">
          <p className="text-[13px] text-droid-text-secondary">
            {loading ? 'Scanning workspaces…' : 'No linked worktrees yet.'}
          </p>
        </div>
      ) : (
        repositories.map((repository) => (
          <section key={repository.root} className="mb-8">
            <div className="mb-2 mt-1 text-[11px] font-medium uppercase tracking-wider text-droid-text-muted">
              {repository.name}
            </div>
            <div className="divide-y divide-droid-border overflow-hidden rounded-xl border border-droid-border bg-droid-surface">
              {repository.worktrees.map((details) => {
                const { worktree } = details;
                const linkedSessions = linkedSessionsForWorktree(worktree.path, sessions);
                const branch = repository.branches.local.find(
                  (candidate) => candidate.name === worktree.branch,
                );
                const isMerged = !worktree.isMain && branch?.merged === true;
                const isInUse =
                  !worktree.isMain &&
                  !!worktree.path &&
                  isWorktreeInUse(worktree.path, sessionCwds);
                return (
                  <WorktreeRow
                    key={worktree.path}
                    details={details}
                    linkedSessions={linkedSessions}
                    activeAppSessionId={state.activeAppSessionId}
                    isMerged={isMerged}
                    isInUse={isInUse}
                    isConfirming={confirming === worktree.path}
                    removing={removing}
                    onConfirm={() => {
                      if (worktree.path) setConfirming(worktree.path);
                    }}
                    onCancel={() => {
                      setConfirming(null);
                    }}
                    onRemove={() => {
                      setConfirming(null);
                      void remove(repository, details);
                    }}
                    onOpenChat={(appSessionId) => {
                      dispatch({ type: 'SET_ACTIVE_SESSION', id: appSessionId });
                      dispatch({ type: 'SELECT_CHILD', selection: null });
                      dispatch({ type: 'TOGGLE_SETTINGS' });
                    }}
                  />
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
