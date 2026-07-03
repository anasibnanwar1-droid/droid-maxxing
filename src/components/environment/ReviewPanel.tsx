import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  AlignLeft,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Copy,
  Eye,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  WrapText,
  X,
} from 'lucide-react';
import { usePopover } from './usePopover';
import { Popover } from './Popover';
import { DiffFileSection } from './DiffFileSection';
import { CommitSheet } from './CommitSheet';
import { CreatePrSheet } from './CreatePrSheet';
import { useReviewDiff } from '../../hooks/useReviewDiff';
import { useReviewFileDiffs } from '../../hooks/useReviewFileDiffs';
import { useGitEnvironment } from '../../hooks/useGitEnvironment';
import { useStore } from '../../hooks/useStore';
import { toast } from '../../lib/toast';
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

function ToolbarButton({
  icon: Icon,
  label,
  title,
  active,
  onClick,
  innerRef,
}: {
  icon: typeof RefreshCw;
  label?: string;
  title: string;
  active?: boolean;
  onClick: () => void;
  innerRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={innerRef}
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors ${
        active
          ? 'bg-droid-elevated text-droid-text'
          : 'text-droid-text-muted hover:bg-droid-elevated/60 hover:text-droid-text'
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label && <span>{label}</span>}
    </button>
  );
}

function MenuItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof RefreshCw;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-droid-text-muted" />
      <span className="flex-1 truncate">{label}</span>
      {active && (
        <Check
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: 'var(--droid-accent)' }}
          strokeWidth={3}
        />
      )}
    </button>
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

// Below this many files a scope loads fully expanded (GitHub-style); larger
// changesets start collapsed so the view stays snappy and the user expands what
// they want to read.
const AUTO_EXPAND_MAX = 25;

export function ReviewPanel({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const { state } = useStore();
  const [filesOpen, setFilesOpen] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [hideWhitespace, setHideWhitespace] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const commitRef = useRef<HTMLButtonElement>(null);
  const prRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const seen = useRef<Set<string>>(new Set());

  const review = useReviewDiff(cwd, state.reviewScope, true);
  const { entries: diffEntries, ensure } = useReviewFileDiffs(
    cwd,
    state.reviewScope,
    hideWhitespace,
    review.signature,
  );
  const git = useGitEnvironment(cwd, 'worktree');
  const isGitHub = !!git.env?.isGitHub;
  const totalAdd = review.files.reduce((sum, f) => sum + f.additions, 0);
  const totalDel = review.files.reduce((sum, f) => sum + f.deletions, 0);
  const allExpanded = review.files.length > 0 && review.files.every((f) => expanded.has(f.path));

  const filesRef = useRef(review.files);
  filesRef.current = review.files;

  // Reconcile the expanded set with the current file list: keep choices for
  // files that still exist, auto-expand newly seen files (small changesets
  // only), and forget files that vanished. Keyed on the content signature so an
  // idle poll returning the same list is a no-op.
  useEffect(() => {
    const paths = filesRef.current.map((f) => f.path);
    const present = new Set(paths);
    setExpanded((cur) => {
      const next = new Set<string>();
      for (const p of cur) if (present.has(p)) next.add(p);
      if (paths.length <= AUTO_EXPAND_MAX) {
        for (const p of paths) if (!seen.current.has(p)) next.add(p);
      }
      return next;
    });
    seen.current = present;
    setActivePath((cur) => (cur && present.has(cur) ? cur : (paths[0] ?? null)));
  }, [review.signature]);

  // Fetch the diff for every open section; ensure() is a no-op for diffs
  // already loaded this generation, so this only does work for freshly opened
  // files or after the signature invalidates the cache.
  useEffect(() => {
    expanded.forEach((p) => ensure(p));
  }, [expanded, review.signature, ensure]);

  const afterAction = () => {
    git.refresh();
    review.refresh();
  };

  const toggle = useCallback((path: string) => {
    setActivePath(path);
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleAll = () => {
    setExpanded(allExpanded ? new Set() : new Set(review.files.map((f) => f.path)));
  };

  const jumpTo = (path: string) => {
    setActivePath(path);
    setExpanded((cur) => (cur.has(path) ? cur : new Set(cur).add(path)));
    requestAnimationFrame(() =>
      sectionRefs.current.get(path)?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    );
  };

  const copyPatch = () => {
    setMoreOpen(false);
    const path = activePath ?? review.files[0]?.path ?? null;
    const diff = path ? (diffEntries[path]?.diff ?? '') : '';
    if (!diff) {
      toast.info('Open a file to copy its diff');
      return;
    }
    void navigator.clipboard
      .writeText(diff)
      .then(() => toast.success('Diff copied'))
      .catch(() => toast.error('Could not copy'));
  };

  return (
    <div className="flex h-full flex-col bg-droid-bg">
      <div className="flex items-center gap-2 border-b border-droid-border px-3 py-2">
        <span className="text-[13px] font-semibold text-droid-text">Review</span>
        <ScopeSelector />
        <div className="flex-1" />
        <ToolbarButton
          icon={GitCommitHorizontal}
          label="Commit"
          title="Commit changes"
          innerRef={commitRef}
          active={commitOpen}
          onClick={() => setCommitOpen((v) => !v)}
        />
        {isGitHub && (
          <ToolbarButton
            icon={GitPullRequest}
            label="PR"
            title="Open a pull request"
            innerRef={prRef}
            active={prOpen}
            onClick={() => setPrOpen((v) => !v)}
          />
        )}
        <ViewToggle />
        <ToolbarButton
          icon={allExpanded ? ChevronsDownUp : ChevronsUpDown}
          title={allExpanded ? 'Collapse all files' : 'Expand all files'}
          onClick={toggleAll}
        />
        <ToolbarButton
          icon={filesOpen ? PanelLeftClose : PanelLeftOpen}
          title={filesOpen ? 'Hide file list' : 'Show file list'}
          active={!filesOpen}
          onClick={() => setFilesOpen((v) => !v)}
        />
        <ToolbarButton
          icon={MoreHorizontal}
          title="More options"
          innerRef={moreRef}
          active={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        />
        <button
          onClick={onClose}
          title="Close review"
          className="rounded-md p-1.5 text-droid-text-muted transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
        >
          <X className="h-4 w-4" />
        </button>

        <Popover
          open={commitOpen}
          onClose={() => setCommitOpen(false)}
          anchorRef={commitRef}
          width={320}
        >
          <CommitSheet
            cwd={cwd}
            onDone={() => {
              setCommitOpen(false);
              afterAction();
            }}
          />
        </Popover>
        <Popover open={prOpen} onClose={() => setPrOpen(false)} anchorRef={prRef} width={340}>
          <CreatePrSheet
            cwd={cwd}
            env={git.env}
            branches={git.branches}
            onDone={() => {
              setPrOpen(false);
              afterAction();
            }}
          />
        </Popover>
        <Popover open={moreOpen} onClose={() => setMoreOpen(false)} anchorRef={moreRef} width={224}>
          <div className="p-1.5">
            <MenuItem
              icon={RefreshCw}
              label="Refresh"
              onClick={() => {
                setMoreOpen(false);
                review.refresh();
              }}
            />
            <MenuItem
              icon={WrapText}
              label="Word wrap"
              active={wrap}
              onClick={() => setWrap((v) => !v)}
            />
            <MenuItem
              icon={Eye}
              label="Hide whitespace"
              active={hideWhitespace}
              onClick={() => setHideWhitespace((v) => !v)}
            />
            <MenuItem icon={Copy} label="Copy patch" onClick={copyPatch} />
          </div>
        </Popover>
      </div>

      <div className="flex min-h-0 flex-1">
        {filesOpen && (
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
                    selected={activePath === file.path}
                    onSelect={() => jumpTo(file.path)}
                  />
                ))
              )}
            </div>
          </div>
        )}

        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto">
          {review.files.length === 0 ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-droid-text-muted">
              {review.loadingList ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </>
              ) : (
                'No changes in this scope'
              )}
            </div>
          ) : (
            review.files.map((file) => (
              <DiffFileSection
                key={file.path}
                file={file}
                open={expanded.has(file.path)}
                active={activePath === file.path}
                entry={diffEntries[file.path]}
                view={state.diffView}
                wrap={wrap}
                onToggle={() => toggle(file.path)}
                innerRef={(el) => {
                  if (el) sectionRefs.current.set(file.path, el);
                  else sectionRefs.current.delete(file.path);
                }}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
