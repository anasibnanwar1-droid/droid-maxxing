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

function UnifiedLine({ line }: { line: DiffLine }) {
  if (line.type === 'meta') {
    return (
      <div className="flex text-droid-text-muted/60">
        <span className="w-20 shrink-0" />
        <span className="whitespace-pre px-2 italic">{line.text}</span>
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
      <span className="whitespace-pre px-1 text-droid-text-secondary">{line.text || ' '}</span>
    </div>
  );
}

function SplitCell({ line }: { line: DiffLine | null }) {
  if (!line) return <div className="flex flex-1 bg-droid-bg/30" />;
  return (
    <div className="flex min-w-0 flex-1" style={{ background: BG[line.type] }}>
      <Gutter value={line.type === 'add' ? line.newLine : line.oldLine} />
      <span
        className="w-4 shrink-0 select-none text-center"
        style={{ color: lineColor(line.type) }}
      >
        {SIGN[line.type]}
      </span>
      <span className="whitespace-pre px-1 text-droid-text-secondary">{line.text || ' '}</span>
    </div>
  );
}

export function DiffBody({
  diff,
  view,
  binary,
}: {
  diff: string;
  view: DiffViewMode;
  binary?: boolean;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);

  if (binary) {
    return <div className="p-4 text-[12.5px] text-droid-text-muted">Binary file not shown</div>;
  }
  if (parsed.hunks.length === 0) {
    return <div className="p-4 text-[12.5px] text-droid-text-muted">No textual changes</div>;
  }

  return (
    <div className="font-mono text-[12px] leading-[1.6]">
      {parsed.hunks.map((hunk, hi) => (
        <div key={hi}>
          <div className="bg-droid-elevated/50 px-2 py-0.5 text-[11px] text-droid-accent/80">
            {hunk.header}
          </div>
          {view === 'split'
            ? toSplitRows(hunk.lines).map((row, ri) => (
                <div key={ri} className="flex">
                  <SplitCell line={row.left} />
                  <div className="w-px shrink-0 bg-droid-border" />
                  <SplitCell line={row.right} />
                </div>
              ))
            : hunk.lines.map((line, li) => <UnifiedLine key={li} line={line} />)}
        </div>
      ))}
    </div>
  );
}
