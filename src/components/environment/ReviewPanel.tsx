import { useCallback, useState } from 'react';
import { AlignLeft, ChevronDown, Columns2, Loader2, RefreshCw, X } from 'lucide-react';
import { usePopover } from './usePopover';
import { DiffBody } from './DiffBody';
import { useReviewDiff } from '../../hooks/useReviewDiff';
import { useStore } from '../../hooks/useStore';
import {
  REVIEW_SCOPE_OPTIONS,
  fileStatusColor,
  fileStatusSymbol,
  reviewScopeLabel,
} from '../../lib/reviewScopes';
import type { DiffFile } from '../../types/vcs';

function ScopeSelector() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const ref = usePopover<HTMLDivElement>(
    open,
    useCallback(() => setOpen(false), []),
  );
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg bg-droid-elevated px-2.5 py-1.5 text-[12px] text-droid-text transition-colors hover:bg-droid-elevated/70"
      >
        <span>{reviewScopeLabel(state.reviewScope)}</span>
        <ChevronDown
          className={`h-3 w-3 text-droid-text-muted/60 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-60 rounded-xl border border-droid-border bg-droid-surface p-1.5 shadow-2xl shadow-black/50">
          {REVIEW_SCOPE_OPTIONS.map((option) => (
            <button
              key={option.scope}
              onClick={() => {
                dispatch({ type: 'SET_REVIEW_SCOPE', scope: option.scope });
                setOpen(false);
              }}
              className={`flex w-full flex-col rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-droid-elevated/60 ${
                option.scope === state.reviewScope ? 'bg-droid-elevated/50' : ''
              }`}
            >
              <span className="text-[12.5px] text-droid-text">{option.label}</span>
              <span className="text-[11px] text-droid-text-muted">{option.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewToggle() {
  const { state, dispatch } = useStore();
  const items = [
    { mode: 'unified' as const, icon: AlignLeft, title: 'Unified' },
    { mode: 'split' as const, icon: Columns2, title: 'Split' },
  ];
  return (
    <div className="flex items-center rounded-lg bg-droid-elevated p-0.5">
      {items.map(({ mode, icon: Icon, title }) => (
        <button
          key={mode}
          onClick={() => dispatch({ type: 'SET_DIFF_VIEW', mode })}
          title={title}
          className={`rounded-md p-1.5 transition-colors ${
            state.diffView === mode
              ? 'bg-droid-bg text-droid-text'
              : 'text-droid-text-muted hover:text-droid-text'
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: DiffFile;
  selected: boolean;
  onSelect: () => void;
}) {
  const slash = file.path.lastIndexOf('/');
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  return (
    <button
      onClick={onSelect}
      title={file.path}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
        selected ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
      }`}
    >
      <span
        className="w-3 shrink-0 text-center font-mono text-[11px] font-semibold"
        style={{ color: fileStatusColor(file.status) }}
      >
        {fileStatusSymbol(file.status)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px]">
        {dir && <span className="text-droid-text-muted/70">{dir}</span>}
        <span className="text-droid-text">{name}</span>
      </span>
      <span className="shrink-0 font-mono text-[10.5px]">
        {file.additions > 0 && (
          <span style={{ color: 'var(--diff-add-fg)' }}>+{file.additions}</span>
        )}{' '}
        {file.deletions > 0 && (
          <span style={{ color: 'var(--diff-del-fg)' }}>-{file.deletions}</span>
        )}
      </span>
    </button>
  );
}

export function ReviewPanel({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const { state } = useStore();
  const review = useReviewDiff(cwd, state.reviewScope, true);
  const totalAdd = review.files.reduce((sum, f) => sum + f.additions, 0);
  const totalDel = review.files.reduce((sum, f) => sum + f.deletions, 0);

  return (
    <div className="flex h-full flex-col bg-droid-bg">
      <div className="flex items-center gap-2 border-b border-droid-border px-3 py-2">
        <span className="text-[13px] font-semibold text-droid-text">Review</span>
        <ScopeSelector />
        <div className="flex-1" />
        <ViewToggle />
        <button
          onClick={review.refresh}
          title="Refresh"
          className="rounded-md p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
        >
          {review.loadingList ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
        <button
          onClick={onClose}
          title="Close review"
          className="rounded-md p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[280px] shrink-0 flex-col border-r border-droid-border">
          <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] text-droid-text-muted">
            <span>
              {review.files.length} file{review.files.length === 1 ? '' : 's'}
            </span>
            <span className="font-mono">
              <span style={{ color: 'var(--diff-add-fg)' }}>+{totalAdd}</span>{' '}
              <span style={{ color: 'var(--diff-del-fg)' }}>-{totalDel}</span>
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {review.files.length === 0 ? (
              <div className="px-2.5 py-3 text-[12px] text-droid-text-muted">
                {review.loadingList ? 'Loading…' : 'No changes in this scope'}
              </div>
            ) : (
              review.files.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  selected={review.selectedPath === file.path}
                  onSelect={() => review.setSelectedPath(file.path)}
                />
              ))
            )}
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {review.selectedPath ? (
            <>
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-droid-border bg-droid-bg/95 px-3 py-1.5 backdrop-blur">
                <span className="truncate font-mono text-[12px] text-droid-text-secondary">
                  {review.selectedPath}
                </span>
                {review.loadingDiff && (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-droid-text-muted" />
                )}
              </div>
              <DiffBody
                diff={
                  review.fileDiff?.path === review.selectedPath ? (review.fileDiff?.diff ?? '') : ''
                }
                view={state.diffView}
                binary={
                  review.fileDiff?.path === review.selectedPath
                    ? review.fileDiff?.binary
                    : undefined
                }
              />
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-[12.5px] text-droid-text-muted">
              Select a file to view its diff
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
