import { useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  RefreshCw,
  SendHorizontal,
} from 'lucide-react';
import { CheckStatusIcon, PrStateIcon } from './GithubIcons';
import { bucketToStatus, checksSummary, prKind, prKindLabel } from '../../lib/github';
import { postPrComment } from '../../lib/github';
import { openExternal } from '../../lib/onboarding';
import { toast } from '../../lib/toast';
import type { PrCheck, PrComment, PullRequest } from '../../types/vcs';
import { Markdown } from '../Markdown';
import { normalizePrCommentBody, prCommentPreview } from '../../lib/prCommentPresentation';

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const ADD_COLOR = 'var(--diff-add-fg)';
const DEL_COLOR = 'var(--diff-del-fg)';

// Before the first detail fetch resolves, an empty list means "not loaded
// yet", not "the PR has none", so show a loading row instead of the
// misleading empty state.
function LoadingRow() {
  return (
    <div className="flex items-center gap-1.5 px-1.5 pb-1.5 text-[12px] text-droid-text-muted">
      <Loader2 className="h-3 w-3 animate-spin" /> Loading…
    </div>
  );
}

// When the detail fetch failed outright (gh/IPC unavailable), an empty list is
// "couldn't load", not "the PR has none"; show a muted error line instead of
// the misleading empty states that are indistinguishable from an empty PR.
function ErrorRow({ message }: { message: string }) {
  return <div className="px-1.5 pb-1.5 text-[12px] text-droid-text-muted">{message}</div>;
}

function ChecksBlock({
  checks,
  loading,
  error,
}: {
  checks: PrCheck[];
  loading: boolean;
  error: string | null;
}) {
  const summary = checksSummary(checks);
  return (
    <div className="px-1.5">
      <div className="flex items-center justify-between px-1.5 pb-1.5 pt-1">
        <span className="text-[12px] font-medium text-droid-text-muted">Checks</span>
        {summary.total > 0 && (
          <span className="font-mono text-[10.5px] text-droid-text-muted">
            {summary.pass}/{summary.total}
          </span>
        )}
      </div>
      {checks.length === 0 ? (
        loading ? (
          <LoadingRow />
        ) : error ? (
          <ErrorRow message={error} />
        ) : (
          <div className="px-1.5 pb-1.5 text-[12px] text-droid-text-muted">No checks reported</div>
        )
      ) : (
        checks.map((check) => (
          <button
            key={`${check.name}-${check.workflow ?? ''}`}
            onClick={() => check.link && void openExternal(check.link)}
            disabled={!check.link}
            className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/50 disabled:cursor-default"
          >
            <span className="self-start pt-0.5">
              <CheckStatusIcon status={bucketToStatus(check.bucket)} size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block break-words text-[12.5px] leading-snug text-droid-text">
                {check.name}
              </span>
              <span className="mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[10px] text-droid-text-muted/70">
                {check.workflow && <span>{check.workflow}</span>}
                <span>{check.state || check.bucket}</span>
              </span>
              {check.description && (
                <span className="mt-0.5 block break-words text-[10.5px] leading-snug text-droid-text-muted">
                  {check.description}
                </span>
              )}
            </span>
            {check.link && (
              <ExternalLink className="h-3 w-3 shrink-0 self-start text-droid-text-muted/60" />
            )}
          </button>
        ))
      )}
    </div>
  );
}

function CommentsBlock({
  comments,
  loading,
  error,
}: {
  comments: PrComment[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="px-1.5 pt-2">
      <div className="px-1.5 pb-1.5 text-[12px] font-medium text-droid-text-muted">
        Comments {comments.length > 0 && `(${comments.length})`}
      </div>
      {comments.length === 0 ? (
        loading ? (
          <LoadingRow />
        ) : error ? (
          <ErrorRow message={error} />
        ) : (
          <div className="px-1.5 pb-1.5 text-[12px] text-droid-text-muted">No comments yet</div>
        )
      ) : (
        <div className="space-y-1.5 px-1.5">
          {comments.map((comment) => (
            <CommentCard key={comment.id} comment={comment} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommentCard({ comment }: { comment: PrComment }) {
  const [expanded, setExpanded] = useState(false);
  const body = normalizePrCommentBody(comment.body);
  const commentUrl = comment.url;
  const lineSuffix =
    comment.line === null || comment.line === undefined ? '' : `:${String(comment.line)}`;
  const location =
    comment.kind === 'inline' && comment.path ? `${comment.path}${lineSuffix}` : null;

  return (
    <div className="overflow-hidden rounded-xl border border-droid-border bg-droid-elevated/20 font-sans transition-colors hover:border-droid-border-hover/80">
      <div className="flex items-start">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-2.5 text-left"
        >
          <ChevronRight
            className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-droid-text-muted transition-transform duration-200 ease-out ${expanded ? 'rotate-90' : ''}`}
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
              <span className="font-medium text-droid-text">{comment.author}</span>
              {comment.state && (
                <span className="rounded bg-droid-elevated px-1 py-0.5 text-[9px] uppercase tracking-wide text-droid-text-muted">
                  {comment.state}
                </span>
              )}
              <span className="text-droid-text-muted/70">{relativeTime(comment.createdAt)}</span>
            </span>
            {location && (
              <span className="mt-0.5 block truncate font-mono text-[9.5px] text-droid-text-muted/75">
                {location}
              </span>
            )}
            {!expanded && (
              <span className="mt-1 block text-xs leading-[1.45] text-droid-text-secondary">
                {prCommentPreview(body)}
              </span>
            )}
            {comment.reactions.length > 0 && <ReactionChips reactions={comment.reactions} />}
          </span>
        </button>
        {commentUrl && (
          <button
            type="button"
            title="Open comment on GitHub"
            onClick={() => void openExternal(commentUrl)}
            className="mr-1.5 mt-1.5 rounded p-1 text-droid-text-muted/50 transition-colors hover:bg-droid-elevated hover:text-droid-text-muted"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        )}
      </div>
      <div
        aria-hidden={!expanded}
        inert={!expanded}
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-droid-border/60 px-3 py-2.5 break-words text-xs leading-[1.5] text-droid-text-secondary [&>div]:!space-y-2 [&>div]:!text-xs [&>div]:!leading-[1.5] [&_code]:!text-[11px]">
            {body ? <Markdown allowDiagrams={false}>{body}</Markdown> : 'No written comment.'}
          </div>
        </div>
      </div>
    </div>
  );
}

const REACTION_DETAILS: Record<string, { emoji: string; label: string }> = {
  THUMBS_UP: { emoji: '👍', label: 'thumbs up' },
  THUMBS_DOWN: { emoji: '👎', label: 'thumbs down' },
  LAUGH: { emoji: '😄', label: 'laugh' },
  HOORAY: { emoji: '🎉', label: 'hooray' },
  CONFUSED: { emoji: '😕', label: 'confused' },
  HEART: { emoji: '❤️', label: 'heart' },
  ROCKET: { emoji: '🚀', label: 'rocket' },
  EYES: { emoji: '👀', label: 'eyes' },
};

function ReactionChips({ reactions }: { reactions: PrComment['reactions'] }) {
  return (
    <span className="mt-1.5 flex flex-wrap gap-1">
      {reactions.map((reaction) => {
        const details = REACTION_DETAILS[reaction.content];
        if (!details) return null;
        return (
          <span
            key={reaction.content}
            title={`${reaction.count} ${details.label}`}
            className="inline-flex items-center gap-1 rounded-full border border-droid-border/80 bg-droid-bg/50 px-1.5 py-0.5 text-[10px] leading-none text-droid-text-muted"
          >
            <span aria-hidden="true">{details.emoji}</span>
            <span>{reaction.count}</span>
          </span>
        );
      })}
    </span>
  );
}

// Replaces the Environment + Progress stack while reviewing a PR: status,
// checks, comments, and a composer that posts straight to the remote PR.
export function PullRequestPanel({
  cwd,
  pr,
  checks,
  comments,
  loadingDetail,
  checksError,
  commentsError,
  onBack,
  onRefresh,
}: {
  cwd: string;
  pr: PullRequest;
  checks: PrCheck[];
  comments: PrComment[];
  loadingDetail: boolean;
  checksError: string | null;
  commentsError: string | null;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  // Synchronous re-entry guard: `posting` state only updates on the next
  // render, so a Cmd/Ctrl+Enter fired again in the same tick would slip past a
  // state check and double-post the comment.
  const postingRef = useRef(false);
  const kind = prKind(pr);

  const submit = async () => {
    const body = draft.trim();
    if (!body || postingRef.current) return;
    postingRef.current = true;
    setPosting(true);
    try {
      const res = await postPrComment(cwd, pr.number, body);
      if (res.ok) {
        toast.success('Comment posted');
        setDraft('');
        onRefresh();
      } else {
        toast.error(res.message || 'Could not post comment');
      }
    } catch {
      toast.error('Could not post comment');
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 pb-1 pt-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-droid-text-muted transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <div className="flex-1" />
        <button
          onClick={onRefresh}
          title="Refresh"
          className="rounded-md p-1 text-droid-text-muted transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
        >
          {loadingDetail ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <button
          onClick={() => pr.url && void openExternal(pr.url)}
          className="group flex w-full items-start gap-2 px-3 pt-1 pb-2 text-left"
        >
          <span className="mt-0.5 shrink-0">
            <PrStateIcon kind={kind} size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium leading-snug text-droid-text">
              {pr.title}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-droid-text-muted">
              <span>#{pr.number}</span>
              <span>· {prKindLabel(kind)}</span>
              {pr.baseRefName && pr.headRefName && (
                <span>
                  · {pr.baseRefName} ← {pr.headRefName}
                </span>
              )}
              {pr.author && <span>· {pr.author}</span>}
            </span>
            <span className="mt-0.5 block font-mono text-[10.5px]">
              <span style={{ color: ADD_COLOR }}>+{pr.additions.toLocaleString()}</span>{' '}
              <span style={{ color: DEL_COLOR }}>-{pr.deletions.toLocaleString()}</span>
              <span className="text-droid-text-muted"> · {pr.changedFiles} files</span>
            </span>
          </span>
          <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-droid-text-muted/50 group-hover:text-droid-text-muted" />
        </button>

        <div className="mx-3 my-1.5 h-px bg-droid-border/70" />
        <ChecksBlock checks={checks} loading={loadingDetail} error={checksError} />
        <div className="mx-3 my-1.5 h-px bg-droid-border/70" />
        <CommentsBlock comments={comments} loading={loadingDetail} error={commentsError} />
      </div>

      <div className="border-t border-droid-border/70 p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
            }}
            rows={2}
            placeholder="Comment on this PR…"
            className="min-h-[36px] w-full resize-none rounded-lg bg-droid-bg/60 px-2.5 py-1.5 text-[12.5px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
          />
          <button
            onClick={() => void submit()}
            disabled={!draft.trim() || posting}
            title="Comment (⌘⏎)"
            className="flex shrink-0 items-center gap-1 rounded-lg bg-droid-accent/15 px-2 py-1.5 text-[11.5px] font-medium text-droid-accent transition-colors hover:bg-droid-accent/25 disabled:opacity-40"
          >
            {posting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <SendHorizontal className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
