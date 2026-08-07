import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight, Loader2 } from 'lucide-react';
import { worktreeName } from '../lib/git';
import { worktreeChatStatus } from '../lib/worktreeSettings';
import type { SessionSummary } from '../types/bridge';
import type { GitWorktree, PullRequest } from '../types/vcs';

function GitHubMergedIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-label="Merged" role="img" className="h-3.5 w-3.5 fill-[#a371f7]">
      <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z" />
    </svg>
  );
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
  checking,
  removing,
  onRequestRemoval,
}: {
  worktree: GitWorktree;
  isInUse: boolean;
  checking: string | null;
  removing: string | null;
  onRequestRemoval: () => void;
}) {
  if (isInUse) {
    return (
      <span
        title="An open or working chat is using this worktree"
        className="shrink-0 rounded-full bg-droid-elevated/70 px-2 py-0.5 text-[10px] text-droid-text-muted"
      >
        in use
      </span>
    );
  }
  return (
    <button
      onClick={onRequestRemoval}
      disabled={removing !== null || checking !== null}
      title="Remove worktree"
      className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-droid-text-muted transition-all duration-150 hover:bg-red-500/10 hover:text-red-400 active:scale-[0.94] disabled:opacity-40"
    >
      {checking === worktree.path || removing === worktree.path ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        'Delete'
      )}
    </button>
  );
}

function WorktreeSummary({
  worktree,
  pullRequest,
  linkedSessionCount,
  isMerged,
  isExpanded,
  onToggle,
}: {
  worktree: GitWorktree;
  pullRequest: PullRequest | null;
  linkedSessionCount: number;
  isMerged: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={linkedSessionCount === 0}
      aria-expanded={linkedSessionCount > 0 ? isExpanded : undefined}
      className="flex min-w-0 flex-1 items-start gap-2.5 text-left transition-opacity duration-150 active:opacity-70 disabled:cursor-default"
    >
      <ChevronRight
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-droid-text-muted transition-transform duration-200 ${
          isExpanded ? 'rotate-90' : ''
        } ${linkedSessionCount === 0 ? 'invisible' : ''}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-droid-text">
            {worktreeName(worktree)}
          </span>
          {isMerged && <GitHubMergedIcon />}
          {pullRequest && (
            <span className="rounded-full border border-droid-accent/15 bg-droid-accent/[0.07] px-1.5 py-0.5 text-[10px] text-droid-accent">
              #{pullRequest.number}{' '}
              {pullRequest.isDraft ? 'draft' : pullRequest.state.toLowerCase()}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-droid-text-muted">
          {worktree.path}
        </span>
        {linkedSessionCount > 0 && (
          <span className="mt-1 block text-[11px] text-droid-text-muted">
            {String(linkedSessionCount)}{' '}
            {linkedSessionCount === 1 ? 'conversation' : 'conversations'}
          </span>
        )}
      </span>
    </button>
  );
}

function ConversationList({
  linkedSessions,
  activeAppSessionId,
  onOpenChat,
}: {
  linkedSessions: SessionSummary[];
  activeAppSessionId: string | null;
  onOpenChat: (appSessionId: string) => void;
}) {
  return (
    <div className="ml-[22px] mt-2 border-l border-droid-border/70 pl-2.5">
      {linkedSessions.map((session) => (
        <motion.button
          key={session.appSessionId}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          onClick={() => {
            onOpenChat(session.appSessionId);
          }}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-all duration-150 hover:bg-droid-elevated/60 active:scale-[0.995] active:bg-droid-elevated/80"
        >
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-droid-text-secondary">
            {session.title}
          </span>
          <ChatStatus session={session} activeAppSessionId={activeAppSessionId} />
        </motion.button>
      ))}
    </div>
  );
}

export function WorktreeSettingsRow({
  worktree,
  pullRequest,
  linkedSessions,
  activeAppSessionId,
  isMerged,
  isInUse,
  isExpanded,
  checking,
  removing,
  onRequestRemoval,
  onToggle,
  onOpenChat,
}: {
  worktree: GitWorktree;
  pullRequest: PullRequest | null;
  linkedSessions: SessionSummary[];
  activeAppSessionId: string | null;
  isMerged: boolean;
  isInUse: boolean;
  isExpanded: boolean;
  checking: string | null;
  removing: string | null;
  onRequestRemoval: () => void;
  onToggle: () => void;
  onOpenChat: (appSessionId: string) => void;
}) {
  const linkedSessionCount = linkedSessions.length;
  return (
    <motion.div
      layout="position"
      transition={{ layout: { duration: 0.16, ease: [0.16, 1, 0.3, 1] } }}
      className="group px-3.5 py-3 transition-colors hover:bg-droid-elevated/25"
    >
      <div className="flex items-start gap-2">
        <WorktreeSummary
          worktree={worktree}
          pullRequest={pullRequest}
          linkedSessionCount={linkedSessionCount}
          isMerged={isMerged}
          isExpanded={isExpanded}
          onToggle={onToggle}
        />
        <WorktreeAction
          worktree={worktree}
          isInUse={isInUse}
          checking={checking}
          removing={removing}
          onRequestRemoval={onRequestRemoval}
        />
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && linkedSessions.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <ConversationList
              linkedSessions={linkedSessions}
              activeAppSessionId={activeAppSessionId}
              onOpenChat={onOpenChat}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
