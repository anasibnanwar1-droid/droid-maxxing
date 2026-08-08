import { AnimatePresence, motion } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../hooks/useStore';
import { reanchorSessionsForWorktreeRemoval } from '../lib/commands';
import {
  getGitBranches,
  getGitDiffStat,
  getGitWorktrees,
  isWorktreeInUse,
  removeGitWorktree,
} from '../lib/git';
import { detectPullRequest } from '../lib/github';
import { activeSessionCwds } from '../lib/sessions';
import { toast } from '../lib/toast';
import { utilityTerminalCwds } from '../lib/utilityPanel';
import { linkedSessionsForWorktree, uniqueWorktreeRepositories } from '../lib/worktreeSettings';
import { removeWorktreeAndReanchor } from '../lib/worktreeRemoval';
import { workspaceName } from '../lib/workspaces';
import type { GitActionResult, GitBranchList, GitWorktree, PullRequest } from '../types/vcs';
import { WorktreeRemovalDialog } from './WorktreeRemovalDialog';
import { WorktreeSettingsRow } from './WorktreeSettingsRow';

const VISIBLE_WORKTREE_LIMIT = 5;
const PULL_REQUEST_LOOKUP_CONCURRENCY = 6;

interface WorktreeDetails {
  worktree: GitWorktree;
  pullRequest: PullRequest | null;
}

interface RepositoryWorktrees {
  root: string;
  branches: GitBranchList;
  worktrees: WorktreeDetails[];
}

interface RemovalConfirmation {
  repository: RepositoryWorktrees;
  details: WorktreeDetails;
  changedFileCount: number | null;
  linkedSessionCount: number;
  isMerged: boolean;
}

function branchWasDeleted(result: GitActionResult): boolean {
  return 'branchDeleted' in result && result.branchDeleted === true;
}

function notifyWorktreeRemoved(
  result: GitActionResult,
  reanchored: number,
  reanchorFailed: boolean,
  branch: string | null,
): void {
  if (reanchorFailed) {
    toast.error('Worktree removed, but linked chats could not be moved to main');
  } else {
    const outcomes = ['Worktree removed'];
    if (reanchored > 0) {
      const chats = reanchored === 1 ? 'chat' : 'chats';
      outcomes.push(`${String(reanchored)} ${chats} moved to main`);
    }
    if (branchWasDeleted(result)) outcomes.push('merged branch deleted');
    toast.success(outcomes.join('; '));
  }
  if (branch && !branchWasDeleted(result)) {
    toast.info('Local branch kept because Git did not confirm it was safe to delete');
  }
}

async function enrichPullRequests(
  repositories: RepositoryWorktrees[],
): Promise<RepositoryWorktrees[]> {
  const candidates: { path: string; branch: string }[] = [];
  for (const repository of repositories) {
    for (const { worktree } of repository.worktrees) {
      if (!worktree.isMain && worktree.path && worktree.branch) {
        candidates.push({ path: worktree.path, branch: worktree.branch });
      }
    }
  }

  const pullRequestsByPath = new Map<string, PullRequest | null>();
  const enrichCandidate = async (index: number): Promise<void> => {
    if (index >= candidates.length) return;
    const candidate = candidates[index];
    const detected = await detectPullRequest(candidate.path, candidate.branch);
    pullRequestsByPath.set(candidate.path, detected.ok ? detected.pr : null);
    await enrichCandidate(index + PULL_REQUEST_LOOKUP_CONCURRENCY);
  };
  await Promise.all(
    candidates.slice(0, PULL_REQUEST_LOOKUP_CONCURRENCY).map((_, index) => enrichCandidate(index)),
  );

  return repositories.map((repository) => ({
    ...repository,
    worktrees: repository.worktrees.map((details) => ({
      ...details,
      pullRequest: details.worktree.path
        ? (pullRequestsByPath.get(details.worktree.path) ?? null)
        : null,
    })),
  }));
}

export function WorktreesSettings() {
  const { state, dispatch } = useStore();
  const [repositories, setRepositories] = useState<RepositoryWorktrees[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<RemovalConfirmation | null>(null);
  const [expandedWorktrees, setExpandedWorktrees] = useState<Set<string>>(() => new Set());
  const [expandedRepositories, setExpandedRepositories] = useState<Set<string>>(() => new Set());
  const loadRequest = useRef(0);
  const removalCheckRequest = useRef(0);
  const removingRef = useRef(false);
  const sessions = useMemo(() => Object.values(state.sessions), [state.sessions]);

  const load = useCallback(async () => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    const candidates = await Promise.all(
      state.workspaceCwds.map(async (cwd) => ({ cwd, worktrees: await getGitWorktrees(cwd) })),
    );
    const loadedRepositories = await Promise.all(
      uniqueWorktreeRepositories(candidates).map(
        async (candidate): Promise<RepositoryWorktrees | null> => {
          const { root } = candidate;
          const worktrees = candidate.worktrees.filter(
            (worktree) => !worktree.bare && worktree.path,
          );
          if (!worktrees.some((worktree) => !worktree.isMain)) return null;
          const branches = await getGitBranches(root);
          return {
            root,
            branches,
            worktrees: worktrees.map((worktree) => ({ worktree, pullRequest: null })),
          };
        },
      ),
    );
    const next = loadedRepositories.filter(
      (repository): repository is RepositoryWorktrees => repository !== null,
    );
    if (requestId !== loadRequest.current) return;
    setRepositories(next);
    setLoading(false);

    void enrichPullRequests(next)
      .then((enriched) => {
        if (requestId === loadRequest.current) setRepositories(enriched);
      })
      .catch((error: unknown) => {
        console.warn('Could not load worktree pull request metadata', error);
      });
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

  const beginRemoval = async (
    repository: RepositoryWorktrees,
    details: WorktreeDetails,
    linkedSessionCount: number,
    isMerged: boolean,
  ) => {
    const path = details.worktree.path;
    if (!path || checking || removing) return;
    const requestId = ++removalCheckRequest.current;
    setChecking(path);
    setConfirmation({
      repository,
      details,
      changedFileCount: null,
      linkedSessionCount,
      isMerged,
    });
    try {
      const status = await getGitDiffStat(path, 'uncommitted');
      if (requestId !== removalCheckRequest.current) return;
      if (!status) {
        setConfirmation(null);
        toast.error('Could not check this worktree for unsaved changes');
        return;
      }
      setConfirmation((current) =>
        current?.details.worktree.path === path
          ? { ...current, changedFileCount: status.files }
          : current,
      );
    } catch (error) {
      if (requestId !== removalCheckRequest.current) return;
      setConfirmation(null);
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not check this worktree for unsaved changes',
      );
    } finally {
      if (requestId === removalCheckRequest.current) setChecking(null);
    }
  };

  const remove = async (
    repository: RepositoryWorktrees,
    details: WorktreeDetails,
    discardChanges: boolean,
  ): Promise<boolean> => {
    const path = details.worktree.path;
    if (!path || removingRef.current) return false;
    removingRef.current = true;
    setRemoving(path);
    try {
      const options = { path, deleteBranch: true, force: discardChanges };
      const { result, reanchored, reanchorFailed } = await removeWorktreeAndReanchor(
        () => removeGitWorktree(repository.root, options),
        () => reanchorSessionsForWorktreeRemoval(path, repository.root),
      );
      if (!result.ok) {
        if (
          result.reason === 'not_clean' ||
          /not.*clean|dirty|contains modified/i.test(result.message ?? '')
        ) {
          toast.error('Has uncommitted changes — commit or discard them first');
        } else {
          toast.error(result.message ?? 'Could not remove worktree');
        }
        return false;
      }
      notifyWorktreeRemoved(result, reanchored, reanchorFailed, details.worktree.branch);
      await load();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not prepare worktree removal');
      return false;
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
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="mx-auto max-w-3xl"
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-droid-text">
            Worktrees
          </h2>
          <p className="mt-1 text-[12.5px] text-droid-text-muted">
            Manage worktrees and open their linked conversations.
          </p>
        </div>
        <button
          onClick={() => void load()}
          title="Refresh worktrees"
          aria-label="Refresh worktrees"
          className="shrink-0 rounded-lg border border-droid-border bg-droid-surface p-2 text-droid-text-muted transition-all duration-150 hover:-translate-y-px hover:border-droid-border-hover hover:bg-droid-elevated/60 hover:text-droid-text active:scale-[0.94]"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {linkedCount === 0 ? (
        <motion.div
          key={loading ? 'loading' : 'empty'}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-dashed border-droid-border bg-droid-surface/40 p-7 text-center"
        >
          <p className="text-[13px] text-droid-text-secondary">
            {loading ? 'Scanning workspaces…' : 'No linked worktrees yet.'}
          </p>
        </motion.div>
      ) : (
        repositories.map((repository, repositoryIndex) => {
          const linkedWorktrees = repository.worktrees.filter(({ worktree }) => !worktree.isMain);
          const repositoryIsExpanded = expandedRepositories.has(repository.root);
          const visibleWorktrees = repositoryIsExpanded
            ? linkedWorktrees
            : linkedWorktrees.slice(0, VISIBLE_WORKTREE_LIMIT);
          const hiddenWorktreeCount = linkedWorktrees.length - visibleWorktrees.length;
          return (
            <motion.section
              key={repository.root}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.18,
                delay: repositoryIndex * 0.03,
                ease: [0.16, 1, 0.3, 1],
              }}
              className="mb-7"
            >
              <div className="mb-2.5 flex min-w-0 items-end justify-between gap-4 px-0.5">
                <div className="min-w-0">
                  <h3 className="truncate text-[13px] font-semibold text-droid-text">
                    {workspaceName(repository.root)}
                  </h3>
                  <p className="mt-0.5 truncate text-[11px] text-droid-text-muted">
                    {repository.root}
                  </p>
                </div>
                <span className="shrink-0 pb-0.5 text-[10.5px] text-droid-text-muted">
                  {String(linkedWorktrees.length)}{' '}
                  {linkedWorktrees.length === 1 ? 'worktree' : 'worktrees'}
                </span>
              </div>
              <div className="divide-y divide-droid-border/80 overflow-hidden rounded-xl border border-droid-border bg-droid-surface shadow-[0_10px_30px_rgba(0,0,0,0.08)]">
                <AnimatePresence initial={false}>
                  {visibleWorktrees.map((details) => {
                    const { worktree } = details;
                    const linkedSessions = linkedSessionsForWorktree(
                      worktree.path,
                      repository.worktrees.map((candidate) => candidate.worktree),
                      sessions,
                    );
                    const branch = repository.branches.local.find(
                      (candidate) => candidate.name === worktree.branch,
                    );
                    const isMerged = branch?.merged === true;
                    const isInUse = !!worktree.path && isWorktreeInUse(worktree.path, sessionCwds);
                    return (
                      <motion.div
                        key={worktree.path}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                      >
                        <WorktreeSettingsRow
                          worktree={worktree}
                          pullRequest={details.pullRequest}
                          linkedSessions={linkedSessions}
                          activeAppSessionId={state.activeAppSessionId}
                          isMerged={isMerged}
                          isInUse={isInUse}
                          isExpanded={!!worktree.path && expandedWorktrees.has(worktree.path)}
                          checking={checking}
                          removing={removing}
                          onRequestRemoval={() => {
                            void beginRemoval(repository, details, linkedSessions.length, isMerged);
                          }}
                          onToggle={() => {
                            const path = worktree.path;
                            if (!path || linkedSessions.length === 0) return;
                            setExpandedWorktrees((current) => {
                              const next = new Set(current);
                              if (next.has(path)) next.delete(path);
                              else next.add(path);
                              return next;
                            });
                          }}
                          onOpenChat={(appSessionId) => {
                            dispatch({ type: 'SET_ACTIVE_SESSION', id: appSessionId });
                            dispatch({ type: 'SELECT_CHILD', selection: null });
                            dispatch({ type: 'TOGGLE_SETTINGS' });
                          }}
                        />
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
                {(hiddenWorktreeCount > 0 || repositoryIsExpanded) && (
                  <button
                    onClick={() => {
                      setExpandedRepositories((current) => {
                        const next = new Set(current);
                        if (repositoryIsExpanded) next.delete(repository.root);
                        else next.add(repository.root);
                        return next;
                      });
                    }}
                    className="flex w-full items-center justify-center border-t border-droid-border/80 px-3 py-2.5 text-[11px] font-medium text-droid-text-muted transition-colors duration-150 hover:bg-droid-elevated/35 hover:text-droid-text active:bg-droid-elevated/55"
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={repositoryIsExpanded ? 'less' : 'more'}
                        initial={{ opacity: 0, y: 3 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -3 }}
                        transition={{ duration: 0.1 }}
                      >
                        {repositoryIsExpanded
                          ? 'Show less'
                          : `Show ${String(hiddenWorktreeCount)} more`}
                      </motion.span>
                    </AnimatePresence>
                  </button>
                )}
              </div>
            </motion.section>
          );
        })
      )}

      <AnimatePresence>
        {confirmation && (
          <WorktreeRemovalDialog
            key={confirmation.details.worktree.path}
            worktree={confirmation.details.worktree}
            changedFileCount={confirmation.changedFileCount}
            linkedSessionCount={confirmation.linkedSessionCount}
            isMerged={confirmation.isMerged}
            isChecking={confirmation.changedFileCount === null}
            isRemoving={removing === confirmation.details.worktree.path}
            onCancel={() => {
              removalCheckRequest.current += 1;
              setChecking(null);
              setConfirmation(null);
            }}
            onConfirm={() => {
              const current = confirmation;
              if (current.changedFileCount === null) return;
              void remove(current.repository, current.details, current.changedFileCount > 0).then(
                (removed) => {
                  if (removed) setConfirmation(null);
                },
              );
            }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
