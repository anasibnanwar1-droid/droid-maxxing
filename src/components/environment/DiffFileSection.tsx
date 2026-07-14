import { memo, useCallback } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { DiffBody } from './DiffBody';
import { fileStatusColor, fileStatusSymbol } from '../../lib/reviewScopes';
import type { DiffViewMode } from '../../hooks/useStore';
import type { FileDiffEntry } from '../../hooks/useReviewFileDiffs';
import type { DiffFile } from '../../types/vcs';

// One collapsible file in the Review tab: a sticky header (status, path, line
// counts) that toggles the file's diff. The diff is fetched lazily the first
// time the section is opened, so a large changeset stays responsive.
// Memoized with path-taking callbacks: the parent re-renders on every diff
// poll tick, and per-file inline closures would otherwise re-render every
// section and detach/re-attach every callback ref each cycle.
export const DiffFileSection = memo(function DiffFileSection({
  file,
  open,
  active,
  entry,
  view,
  wrap,
  onToggle,
  onSectionRef,
}: {
  file: DiffFile;
  open: boolean;
  active: boolean;
  entry: FileDiffEntry | undefined;
  view: DiffViewMode;
  wrap: boolean;
  onToggle: (path: string) => void;
  onSectionRef: (path: string, el: HTMLDivElement | null) => void;
}) {
  const { path } = file;
  const sectionRef = useCallback(
    (el: HTMLDivElement | null) => onSectionRef(path, el),
    [onSectionRef, path],
  );
  const slash = file.path.lastIndexOf('/');
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  return (
    <div ref={sectionRef} className="border-b border-droid-border/70">
      <button
        onClick={() => onToggle(path)}
        title={file.path}
        aria-expanded={open}
        className={`sticky top-0 z-10 flex w-full items-center gap-2 border-b border-droid-border/50 px-3 py-1.5 text-left transition-colors ${
          active ? 'bg-droid-elevated' : 'bg-droid-surface hover:bg-droid-elevated'
        }`}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-droid-text-muted/60 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span
          className="w-3 shrink-0 text-center font-mono text-[11px] font-semibold"
          style={{ color: fileStatusColor(file.status) }}
        >
          {fileStatusSymbol(file.status)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
          {dir && <span className="text-droid-text-muted/70">{dir}</span>}
          <span className="text-droid-text-secondary">{name}</span>
        </span>
        {entry?.loading && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-droid-text-muted" />
        )}
        <span className="shrink-0 font-mono text-[10.5px]">
          {file.additions > 0 && (
            <span style={{ color: 'var(--diff-add-fg)' }}>+{file.additions}</span>
          )}{' '}
          {file.deletions > 0 && (
            <span style={{ color: 'var(--diff-del-fg)' }}>-{file.deletions}</span>
          )}
        </span>
      </button>
      {open &&
        (entry?.loaded ? (
          <DiffBody
            diff={entry.diff}
            view={view}
            binary={file.binary || entry.binary}
            wrap={wrap}
          />
        ) : (
          <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-droid-text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading diff…
          </div>
        ))}
    </div>
  );
});
