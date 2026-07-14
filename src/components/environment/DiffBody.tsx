import { useMemo } from 'react';
import { parseUnifiedDiff, toSplitRows, type DiffLine } from '../../lib/unifiedDiff';
import type { DiffViewMode } from '../../hooks/useStore';

const BG: Record<DiffLine['type'], string> = {
  add: 'var(--diff-add-bg)',
  del: 'var(--diff-del-bg)',
  ctx: 'transparent',
  meta: 'transparent',
};
const SIGN: Record<DiffLine['type'], string> = { add: '+', del: '-', ctx: ' ', meta: '' };

const MAX_RENDERED_LINES = 3000;

function lineColor(type: DiffLine['type']): string {
  if (type === 'add') return 'var(--diff-add-fg)';
  if (type === 'del') return 'var(--diff-del-fg)';
  return 'var(--droid-text-secondary)';
}

function Gutter({ value }: { value: number | null }) {
  return (
    <span className="w-10 shrink-0 select-none px-1.5 text-right text-droid-text-muted/50">
      {value ?? ''}
    </span>
  );
}

function UnifiedLine({ line, wrap }: { line: DiffLine; wrap: boolean }) {
  const textClass = wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre';
  if (line.type === 'meta') {
    return (
      <div className="flex text-droid-text-muted/60">
        <span className="w-20 shrink-0" />
        <span className={`${textClass} px-2 italic`}>{line.text}</span>
      </div>
    );
  }
  return (
    <div className="flex" style={{ background: BG[line.type] }}>
      <Gutter value={line.oldLine} />
      <Gutter value={line.newLine} />
      <span
        className="w-4 shrink-0 select-none text-center"
        style={{ color: lineColor(line.type) }}
      >
        {SIGN[line.type]}
      </span>
      <span className={`${textClass} min-w-0 flex-1 px-1 text-droid-text-secondary`}>
        {line.text || ' '}
      </span>
    </div>
  );
}

function SplitCell({
  line,
  side,
  wrap,
}: {
  line: DiffLine | null;
  side: 'left' | 'right';
  wrap: boolean;
}) {
  if (!line) return <div className="flex flex-1 bg-droid-bg/30" />;
  const textClass = wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre';
  return (
    <div className="flex min-w-0 flex-1" style={{ background: BG[line.type] }}>
      {/* The left pane is the old file, the right pane the new one; a context
          row carries both numbers, so pick by side rather than by line type. */}
      <Gutter value={side === 'left' ? line.oldLine : line.newLine} />
      <span
        className="w-4 shrink-0 select-none text-center"
        style={{ color: lineColor(line.type) }}
      >
        {SIGN[line.type]}
      </span>
      <span className={`${textClass} min-w-0 flex-1 px-1 text-droid-text-secondary`}>
        {line.text || ' '}
      </span>
    </div>
  );
}

export function DiffBody({
  diff,
  view,
  binary,
  wrap = false,
}: {
  diff: string;
  view: DiffViewMode;
  binary?: boolean;
  wrap?: boolean;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);

  // Every diff line becomes several DOM nodes, so a huge diff (generated file,
  // lockfile) would freeze the renderer; cap what we mount and say so.
  const { hunks, hiddenLines } = useMemo(() => {
    let total = 0;
    for (const hunk of parsed.hunks) total += hunk.lines.length;
    if (total <= MAX_RENDERED_LINES) return { hunks: parsed.hunks, hiddenLines: 0 };
    let budget = MAX_RENDERED_LINES;
    const capped: typeof parsed.hunks = [];
    for (const hunk of parsed.hunks) {
      if (budget <= 0) break;
      capped.push(
        hunk.lines.length <= budget ? hunk : { ...hunk, lines: hunk.lines.slice(0, budget) },
      );
      budget -= hunk.lines.length;
    }
    return { hunks: capped, hiddenLines: total - MAX_RENDERED_LINES };
  }, [parsed]);

  if (binary) {
    return <div className="p-4 text-[12.5px] text-droid-text-muted">Binary file not shown</div>;
  }
  if (parsed.hunks.length === 0) {
    return <div className="p-4 text-[12.5px] text-droid-text-muted">No textual changes</div>;
  }

  return (
    <div className="font-mono text-[12px] leading-[1.6]">
      {hunks.map((hunk, hi) => (
        <div key={hi}>
          <div className="bg-droid-elevated/50 px-2 py-0.5 text-[11px] text-droid-accent/80">
            {hunk.header}
          </div>
          {view === 'split'
            ? toSplitRows(hunk.lines).map((row, ri) =>
                row.left?.type === 'meta' ? (
                  <UnifiedLine key={ri} line={row.left} wrap={wrap} />
                ) : (
                  <div key={ri} className="flex">
                    <SplitCell line={row.left} side="left" wrap={wrap} />
                    <div className="w-px shrink-0 bg-droid-border" />
                    <SplitCell line={row.right} side="right" wrap={wrap} />
                  </div>
                ),
              )
            : hunk.lines.map((line, li) => <UnifiedLine key={li} line={line} wrap={wrap} />)}
        </div>
      ))}
      {hiddenLines > 0 && (
        <div className="px-3 py-2 text-[11.5px] text-droid-text-muted">
          Diff truncated: {hiddenLines.toLocaleString()} more lines not shown
        </div>
      )}
    </div>
  );
}
