import { useCallback, useState } from 'react';
import { Check, ChevronDown, FileDiff } from 'lucide-react';
import { usePopover } from './usePopover';
import { DIFF_MODES, diffModeLabel } from '../../lib/git';
import type { DiffStatMode, GitDiffStat } from '../../types/vcs';

const ADD_COLOR = '#3fb950';
const DEL_COLOR = '#f85149';

// The "changes summed up" row. Shows additions/deletions with a subtle dropdown
// to switch between the worktree total, the branch vs origin, and uncommitted.
export function DiffStat({
  stat,
  mode,
  defaultBranch,
  onModeChange,
}: {
  stat: GitDiffStat | null;
  mode: DiffStatMode;
  defaultBranch?: string | null;
  onModeChange: (mode: DiffStatMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = usePopover<HTMLDivElement>(
    open,
    useCallback(() => setOpen(false), []),
  );
  const additions = stat?.additions ?? 0;
  const deletions = stat?.deletions ?? 0;
  const clean = additions === 0 && deletions === 0;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Change which changes are summed"
        className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
          open ? 'bg-droid-elevated' : 'hover:bg-droid-elevated/50'
        }`}
      >
        <span className="shrink-0 text-droid-text-muted transition-colors group-hover:text-droid-text-secondary">
          <FileDiff className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1 text-[13px] leading-snug text-droid-text">
          <span className="truncate">{diffModeLabel(mode, defaultBranch)}</span>
          <ChevronDown
            className={`h-3 w-3 shrink-0 text-droid-text-muted/50 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
        <span className="shrink-0 font-mono text-[11px]">
          {clean ? (
            <span className="text-droid-text-muted">Clean</span>
          ) : (
            <>
              <span style={{ color: ADD_COLOR }}>+{additions.toLocaleString()}</span>{' '}
              <span style={{ color: DEL_COLOR }}>-{deletions.toLocaleString()}</span>
            </>
          )}
        </span>
      </button>

      {open && (
        <div className="absolute right-2 top-full z-50 mt-1 w-56 rounded-xl border border-droid-border bg-droid-surface p-1.5 shadow-2xl shadow-black/50">
          {DIFF_MODES.map((option) => (
            <button
              key={option}
              onClick={() => {
                onModeChange(option);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
            >
              <span className="flex-1 truncate">{diffModeLabel(option, defaultBranch)}</span>
              {option === mode && (
                <Check
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--droid-accent)' }}
                  strokeWidth={3}
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
