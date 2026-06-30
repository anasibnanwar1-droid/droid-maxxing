import { useState } from 'react';
import { ChevronLeft, ExternalLink, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { CheckStatusIcon, PrStateIcon } from './GithubIcons';
import { bucketToStatus, checksSummary, prKind, prKindLabel } from '../../lib/github';
import { postPrComment } from '../../lib/github';
import { openExternal } from '../../lib/onboarding';
import { toast } from '../../lib/toast';
import type { PrCheck, PrComment, PullRequest } from '../../types/vcs';

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

function ChecksBlock({ checks }: { checks: PrCheck[] }) {
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
        <div className="px-1.5 pb-1.5 text-[12px] text-droid-text-muted">No checks reported</div>
      ) : (
        checks.map((check) => (
          <button
            key={`${check.name}-${check.workflow ?? ''}`}
            onClick={() => check.link && void openExternal(check.link)}
            disabled={!check.link}
            className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-droid-elevated/50 disabled:cursor-default"
          >
            <CheckStatusIcon status={bucketToStatus(check.bucket)} size={14} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-droid-text">
              {check.name}
            </span>
            {check.workflow && (
              <span className="shrink-0 truncate text-[10px] text-droid-text-muted/70">
                {check.workflow}
              </span>
            )}
            {check.link && <ExternalLink className="h-3 w-3 shrink-0 text-droid-text-muted/60" />}
          </button>
        ))
      )}
    </div>
  );
}

function CommentsBlock({ comments }: { comments: PrComment[] }) {
  return (
    <div className="px-1.5 pt-2">
      <div className="px-1.5 pb-1.5 text-[12px] font-medium text-droid-text-muted">
        Comments {comments.length > 0 && `(${comments.length})`}
      </div>
      {comments.length === 0 ? (
        <div className="px-1.5 pb-1.5 text-[12px] text-droid-text-muted">No comments yet</div>
      ) : (
        comments.map((comment) => (
          <div key={comment.id} className="px-1.5 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="font-medium text-droid-text">{comment.author}</span>
              {comment.state && (
                <span className="rounded bg-droid-elevated px-1 py-0.5 text-[9px] uppercase tracking-wide text-droid-text-muted">
                  {comment.state}
                </span>
              )}
              <span className="text-droid-text-muted/70">{relativeTime(comment.createdAt)}</span>
            </div>
            {comment.body && (
              <div className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-snug text-droid-text-secondary">
                {comment.body}
              </div>
            )}
          </div>
        ))
      )}
    </div>
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
  onBack,
  onRefresh,
}: {
  cwd: string;
  pr: PullRequest;
  checks: PrCheck[];
  comments: PrComment[];
  loadingDetail: boolean;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const kind = prKind(pr);

  const submit = async () => {
    const body = draft.trim();
    // Guard re-entry: the Cmd/Ctrl+Enter shortcut can fire again while a post is
    // in flight even though the button is disabled, which would double-post.
    if (!body || posting) return;
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
      setPosting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
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
        <ChecksBlock checks={checks} />
        <div className="mx-3 my-1.5 h-px bg-droid-border/70" />
        <CommentsBlock comments={comments} />
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
              <MessageSquare className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
