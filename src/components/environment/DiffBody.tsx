import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { parseUnifiedDiff, toSplitRows, type DiffLine } from '../../lib/unifiedDiff';
import type { DiffViewMode } from '../../hooks/useStore';

// Shared per-type style objects: a large diff renders thousands of lines, so
// inline object literals would allocate on every line every render.
const ROW_STYLE: Record<DiffLine['type'], CSSProperties> = {
  add: { background: 'var(--diff-add-bg)' },
  del: { background: 'var(--diff-del-bg)' },
  ctx: { background: 'transparent' },
  meta: { background: 'transparent' },
};
const SIGN_STYLE: Record<DiffLine['type'], CSSProperties> = {
  add: { color: 'var(--diff-add-fg)' },
  del: { color: 'var(--diff-del-fg)' },
  ctx: { color: 'var(--droid-text-secondary)' },
  meta: { color: 'var(--droid-text-secondary)' },
};
const SIGN: Record<DiffLine['type'], string> = { add: '+', del: '-', ctx: ' ', meta: '' };

const MAX_RENDERED_LINES = 3000;

// Large diffs are mounted in fixed-size chunks: `content-visibility: auto`
// lets the browser skip layout/paint for offscreen chunks, and only a few
// chunks mount per frame so a big file never lands in one synchronous React
// commit (thousands of rows at 5-9 DOM nodes each would drop frames for
// hundreds of ms). The intrinsic-size estimate only seeds the scrollbar; once
// a chunk has rendered, `auto` remembers its real height (wrap included).
const CHUNK_ROWS = 200;
const INITIAL_CHUNKS = 3;
const CHUNKS_PER_FRAME = 2;
const EST_ROW_PX = 19.2; // 12px font at 1.6 line-height

function Gutter({ value }: { value: number | null }) {
  return (
    <span className="w-10 shrink-0 select-none px-1.5 text-right text-droid-text-muted/50">
      {value ?? ''}
    </span>
  );
}

// Memoized: hunk line arrays are stable across parent re-renders (memoized
// parse), so thousands of line rows can skip reconciliation during polling.
const UnifiedLine = memo(function UnifiedLine({ line, wrap }: { line: DiffLine; wrap: boolean }) {
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
    <div className="flex" style={ROW_STYLE[line.type]}>
      <Gutter value={line.oldLine} />
      <Gutter value={line.newLine} />
      <span className="w-4 shrink-0 select-none text-center" style={SIGN_STYLE[line.type]}>
        {SIGN[line.type]}
      </span>
      <span className={`${textClass} min-w-0 flex-1 px-1 text-droid-text-secondary`}>
        {line.text || ' '}
      </span>
    </div>
  );
});

const SplitCell = memo(function SplitCell({
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
  const isMeta = line.type === 'meta';
  return (
    <div className="flex min-w-0 flex-1" style={ROW_STYLE[line.type]}>
      {/* The left pane is the old file, the right pane the new one; a context
          row carries both numbers, so pick by side rather than by line type. */}
      <Gutter value={side === 'left' ? line.oldLine : line.newLine} />
      <span className="w-4 shrink-0 select-none text-center" style={SIGN_STYLE[line.type]}>
        {SIGN[line.type]}
      </span>
      <span
        className={`${textClass} min-w-0 flex-1 px-1 ${
          isMeta ? 'italic text-droid-text-muted/60' : 'text-droid-text-secondary'
        }`}
      >
        {line.text || ' '}
      </span>
    </div>
  );
});

type Row =
  | { kind: 'header'; text: string }
  | { kind: 'line'; line: DiffLine }
  | { kind: 'split'; left: DiffLine | null; right: DiffLine | null };

function RowView({ row, wrap }: { row: Row; wrap: boolean }) {
  if (row.kind === 'header') {
    return (
      <div className="bg-droid-elevated/50 px-2 py-0.5 text-[11px] text-droid-accent/80">
        {row.text}
      </div>
    );
  }
  if (row.kind === 'line') return <UnifiedLine line={row.line} wrap={wrap} />;
  return (
    <div className="flex">
      <SplitCell line={row.left} side="left" wrap={wrap} />
      <div className="w-px shrink-0 bg-droid-border" />
      <SplitCell line={row.right} side="right" wrap={wrap} />
    </div>
  );
}

// Memoized so polling-driven parent re-renders skip every already-mounted
// chunk (its rows slice is referentially stable while the diff is unchanged).
const Chunk = memo(function Chunk({ rows, wrap }: { rows: Row[]; wrap: boolean }) {
  return (
    <div
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: `auto ${Math.round(rows.length * EST_ROW_PX)}px`,
      }}
    >
      {rows.map((row, i) => (
        <RowView key={i} row={row} wrap={wrap} />
      ))}
    </div>
  );
});

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
      // A cut hunk keeps its original @@ header, whose line counts no longer
      // match what is rendered (and a replacement block may lose its add side);
      // flag it so the header doesn't claim to be complete.
      capped.push(
        hunk.lines.length <= budget
          ? hunk
          : { ...hunk, header: `${hunk.header} (truncated)`, lines: hunk.lines.slice(0, budget) },
      );
      budget -= hunk.lines.length;
    }
    return { hunks: capped, hiddenLines: total - MAX_RENDERED_LINES };
  }, [parsed]);

  // Pairing rows for split view is O(lines); memoize per hunk so polling-driven
  // re-renders don't recompute it on every frame.
  const splitRows = useMemo(
    () => (view === 'split' ? hunks.map((hunk) => toSplitRows(hunk.lines)) : null),
    [view, hunks],
  );

  // Flatten headers and lines into one row stream so chunking can cut across
  // hunk boundaries; a meta row in split view spans both panes.
  const rows = useMemo(() => {
    const out: Row[] = [];
    hunks.forEach((hunk, hi) => {
      out.push({ kind: 'header', text: hunk.header });
      if (splitRows) {
        // Meta markers ("\ No newline at end of file") are column-scoped by
        // toSplitRows, so they render as split cells like any other row.
        for (const row of splitRows[hi]) {
          out.push({ kind: 'split', left: row.left, right: row.right });
        }
      } else {
        for (const line of hunk.lines) out.push({ kind: 'line', line });
      }
    });
    return out;
  }, [hunks, splitRows]);

  const chunks = useMemo(() => {
    const out: Row[][] = [];
    for (let i = 0; i < rows.length; i += CHUNK_ROWS) out.push(rows.slice(i, i + CHUNK_ROWS));
    return out;
  }, [rows]);

  // Progressive mount: start with a few chunks and add a couple per frame until
  // the whole diff is in the DOM. Reset during render (the supported pattern
  // for derived-state resets) whenever the diff content or view changes.
  const [mounted, setMounted] = useState(INITIAL_CHUNKS);
  const [prevRows, setPrevRows] = useState(rows);
  if (prevRows !== rows) {
    setPrevRows(rows);
    setMounted(INITIAL_CHUNKS);
  }
  useEffect(() => {
    if (mounted >= chunks.length) return;
    const raf = requestAnimationFrame(() => setMounted((v) => v + CHUNKS_PER_FRAME));
    return () => cancelAnimationFrame(raf);
  }, [mounted, chunks.length]);

  const pendingRows = Math.max(0, rows.length - mounted * CHUNK_ROWS);

  if (binary || parsed.binary) {
    return <div className="p-4 text-[12.5px] text-droid-text-muted">Binary file not shown</div>;
  }
  if (parsed.hunks.length === 0) {
    return <div className="p-4 text-[12.5px] text-droid-text-muted">No textual changes</div>;
  }

  return (
    <div className="font-mono text-[12px] leading-[1.6]">
      {chunks.slice(0, mounted).map((chunk, ci) => (
        <Chunk key={ci} rows={chunk} wrap={wrap} />
      ))}
      {/* Placeholder for not-yet-mounted chunks so the scroll height is stable
          while the progressive mount catches up. */}
      {pendingRows > 0 && <div style={{ height: Math.round(pendingRows * EST_ROW_PX) }} />}
      {hiddenLines > 0 && (
        <div className="px-3 py-2 text-[11.5px] text-droid-text-muted">
          Diff truncated: {hiddenLines.toLocaleString()} more lines not shown
        </div>
      )}
    </div>
  );
}
