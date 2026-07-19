import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
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
import { detectPullRequest } from '../../lib/github';
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

const VIEW_TOGGLE_ITEMS = [
  { mode: 'unified' as const, icon: AlignLeft, title: 'Unified' },
  { mode: 'split' as const, icon: Columns2, title: 'Split' },
];

function ViewToggle() {
  const { state, dispatch } = useStore();
  return (
    <div className="flex items-center rounded-lg bg-droid-elevated p-0.5">
      {VIEW_TOGGLE_ITEMS.map(({ mode, icon: Icon, title }) => (
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

const FileRow = memo(function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: DiffFile;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const slash = file.path.lastIndexOf('/');
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  return (
    <button
      onClick={() => onSelect(file.path)}
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
});

// Below this many files a scope loads fully expanded (GitHub-style); larger
// changesets start collapsed so the view stays snappy and the user expands what
// they want to read.
const AUTO_EXPAND_MAX = 25;

// The file sidebar and diff-section column render at most this many rows at
// once; huge changesets (hundreds of files) otherwise mount thousands of DOM
// nodes and re-create them on every poll. "Show more" reveals the rest in
// increments, and jumpTo raises the limit when the target sits past it.
const FILE_RENDER_CAP = 100;

// When jumping to a file past the render cap, only raise the limit enough to
// include a small buffer after the target rather than FILE_RENDER_CAP more rows.
// This avoids mounting hundreds of preceding DOM nodes. A true fix would
// require windowing/virtualization; this is the bounded improvement.
const FILE_RENDER_JUMP_BUFFER = 20;

export function ReviewPanel({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [filesOpen, setFilesOpen] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [hideWhitespace, setHideWhitespace] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [renderLimit, setRenderLimit] = useState(FILE_RENDER_CAP);
  const commitRef = useRef<HTMLButtonElement>(null);
  const prRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const seen = useRef<Set<string>>(new Set());

  const sessionId = state.activeMissionId ?? undefined;
  const review = useReviewDiff(cwd, state.reviewScope, true, sessionId);
  const { entries: diffEntries, ensure } = useReviewFileDiffs(
    cwd,
    state.reviewScope,
    hideWhitespace,
    review.signature,
    sessionId,
  );
  const git = useGitEnvironment(cwd, 'worktree');
  const isGitHub = !!git.env?.isGitHub;
  // The Review pane has no PR polling of its own, so without this flag the PR
  // button would stay live after a successful create and a second submit would
  // surface GitHub's raw "already exists" error. Reset when the branch changes,
  // where opening a new PR is legitimate again.
  const [prCreated, setPrCreated] = useState(false);
  // One-shot detection per cwd/branch: a branch may already have an open PR
  // from a previous session or another tool, in which case offering "Create PR"
  // would only surface GitHub's duplicate-PR error on submit. Only an OPEN PR
  // blocks the button: a merged or closed PR leaves the branch free to open a
  // subsequent one. The button stays hidden until detection settles so a fast
  // click can't race a pending lookup into that same duplicate-PR error.
  const [hasPr, setHasPr] = useState(false);
  const [prChecked, setPrChecked] = useState(false);
  const branch = git.env?.branch ?? null;
  useEffect(() => {
    setPrCreated(false);
    setHasPr(false);
    setPrChecked(false);
    if (!isGitHub || !branch) return;
    let stale = false;
    void detectPullRequest(cwd, branch).then((res) => {
      if (stale) return;
      // Settle on failure too so a gh hiccup can't hide the button forever.
      setPrChecked(true);
      if (res.ok && res.pr && res.pr.state.toLowerCase() === 'open') {
        setHasPr(true);
        // If the create form was already open when an existing PR turned up,
        // close it rather than leaving a submit that is guaranteed to fail.
        setPrOpen(false);
      }
    });
    return () => {
      stale = true;
    };
  }, [cwd, branch, isGitHub]);
  useEffect(() => {
    setRenderLimit(FILE_RENDER_CAP);
  }, [cwd, state.reviewScope]);
  const { totalAdd, totalDel } = useMemo(
    () => ({
      totalAdd: review.files.reduce((sum, f) => sum + f.additions, 0),
      totalDel: review.files.reduce((sum, f) => sum + f.deletions, 0),
    }),
    [review.files],
  );
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
    // Capture before mutating: the setExpanded updater runs on the next render,
    // after `seen.current = present` below, so reading the ref inside it would
    // always report every path as seen and never auto-expand anything.
    const prevSeen = seen.current;
    setExpanded((cur) => {
      const next = new Set<string>();
      for (const p of cur) if (present.has(p)) next.add(p);
      if (paths.length <= AUTO_EXPAND_MAX) {
        for (const p of paths) if (!prevSeen.has(p)) next.add(p);
      }
      return next;
    });
    seen.current = present;
    setActivePath((cur) => (cur && present.has(cur) ? cur : (paths[0] ?? null)));
  }, [review.signature]);

  // After a scope/worktree change resets the render limit, raise it if the
  // active file sits past the cap so its selection stays visible.
  useEffect(() => {
    if (!activePath) return;
    const idx = filesRef.current.findIndex((f) => f.path === activePath);
    if (idx >= 0) setRenderLimit((cur) => (idx < cur ? cur : idx + FILE_RENDER_JUMP_BUFFER));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, review.signature]);

  // Fetch the diff for every open section that is actually rendered; ensure()
  // is a no-op for diffs already loaded this generation, so this only does
  // work for freshly opened files or after the signature invalidates the
  // cache. Sections past the render cap fetch lazily when revealed, but the
  // active file is always fetched so Copy patch reflects the current generation.
  useEffect(() => {
    const visible = new Set(review.files.slice(0, renderLimit).map((f) => f.path));
    expanded.forEach((p) => {
      if (visible.has(p)) ensure(p);
    });
    if (activePath) ensure(activePath);
  }, [expanded, activePath, review.signature, ensure, review.files, renderLimit]);

  const afterAction = () => {
    git.refresh();
    review.refresh();
  };

  const registerSection = useCallback((path: string, el: HTMLDivElement | null) => {
    if (el) sectionRefs.current.set(path, el);
    else sectionRefs.current.delete(path);
  }, []);

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

  const jumpTo = useCallback((path: string) => {
    setActivePath(path);
    const idx = filesRef.current.findIndex((f) => f.path === path);
    if (idx >= 0) setRenderLimit((cur) => (idx < cur ? cur : idx + FILE_RENDER_JUMP_BUFFER));
    setExpanded((cur) => (cur.has(path) ? cur : new Set(cur).add(path)));
    // Two frames: the first lets React commit a raised render limit so the
    // target section exists before scrollIntoView runs.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        sectionRefs.current.get(path)?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
      ),
    );
  }, []);

  // Honor a focus request (e.g. a per-turn changes summary clicked in chat):
  // once the diff list contains the requested file, expand and scroll to it,
  // then clear the request so a later poll can't re-trigger the jump. Transcript
  // edit paths are often absolute while git lists paths relative to the repo
  // root, so match on an exact hit or a path-suffix rather than strict equality.
  useEffect(() => {
    const focus = state.reviewFocusPath;
    if (!focus) return;
    const norm = focus.replace(/\\/g, '/');
    const target = review.files.find(
      (f) => f.path === focus || f.path === norm || norm.endsWith(`/${f.path}`),
    );
    if (!target) {
      // A settled list without the file means the request can't be honored in
      // this scope. Drop it now; keeping it would re-run this effect on every
      // poll (signature changes) and surprise-jump if the file appears after
      // the user has navigated elsewhere.
      if (!review.loadingList) dispatch({ type: 'CLEAR_REVIEW_FOCUS' });
      return;
    }
    jumpTo(target.path);
    dispatch({ type: 'CLEAR_REVIEW_FOCUS' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.reviewFocusPath, review.signature, review.loadingList]);

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
        {isGitHub && prChecked && !prCreated && !hasPr && (
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
          label="Commit changes"
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
        <Popover
          open={prOpen}
          onClose={() => setPrOpen(false)}
          anchorRef={prRef}
          label="Create pull request"
          width={340}
        >
          <CreatePrSheet
            cwd={cwd}
            env={git.env}
            branches={git.branches}
            onCreated={() => setPrCreated(true)}
            onDone={() => {
              setPrOpen(false);
              afterAction();
            }}
          />
        </Popover>
        <Popover
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          anchorRef={moreRef}
          label="Review options"
          width={224}
        >
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
                <>
                  {review.files.slice(0, renderLimit).map((file) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      selected={activePath === file.path}
                      onSelect={jumpTo}
                    />
                  ))}
                  {review.files.length > renderLimit && (
                    <button
                      onClick={() => setRenderLimit((cur) => cur + FILE_RENDER_CAP)}
                      className="w-full px-2.5 py-2 text-left text-[12px] text-droid-accent transition-colors hover:bg-droid-elevated/50"
                    >
                      Show {Math.min(FILE_RENDER_CAP, review.files.length - renderLimit)} more
                      files…
                    </button>
                  )}
                </>
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
            <>
              {review.files.slice(0, renderLimit).map((file) => (
                <DiffFileSection
                  key={file.path}
                  file={file}
                  open={expanded.has(file.path)}
                  active={activePath === file.path}
                  entry={diffEntries[file.path]}
                  view={state.diffView}
                  wrap={wrap}
                  onToggle={toggle}
                  onSectionRef={registerSection}
                />
              ))}
              {review.files.length > renderLimit && (
                <button
                  onClick={() => setRenderLimit((cur) => cur + FILE_RENDER_CAP)}
                  className="w-full px-3 py-2.5 text-left text-[12.5px] text-droid-accent transition-colors hover:bg-droid-elevated/40"
                >
                  Show {Math.min(FILE_RENDER_CAP, review.files.length - renderLimit)} more files…
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
