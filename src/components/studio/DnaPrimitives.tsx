/** Shared visual primitives for the Design DNA surfaces — swatches, fonts,
 *  scales, section headers. Kept tiny so DnaShelf and the draft proposal reuse
 *  one source of truth instead of duplicating markup. */

export function Header({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between pb-2 pt-1">
      <span className="text-[12px] font-medium text-droid-text-secondary">{title}</span>
      {action}
    </div>
  );
}

export function Swatches({ colors }: { colors: string[] }) {
  if (colors.length === 0) return null;
  return (
    <div className="mt-2.5 flex gap-1">
      {colors.slice(0, 12).map((c, i) => (
        <div
          key={`${c}-${String(i)}`}
          className="h-6 flex-1 rounded-md ring-1 ring-inset ring-droid-border"
          style={{ backgroundColor: c }}
          title={c}
        />
      ))}
    </div>
  );
}

export function FontLine({ fonts }: { fonts: { sans?: string; display?: string; mono?: string } }) {
  const names = [fonts.display, fonts.sans, fonts.mono].filter(Boolean) as string[];
  if (names.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {names.map((n) => (
        <span
          key={n}
          className="rounded bg-droid-elevated/55 px-1.5 py-0.5 text-[10px] text-droid-text-muted"
        >
          {family(n)}
        </span>
      ))}
    </div>
  );
}

export function TypeScale({ scale }: { scale: number[] }) {
  if (scale.length === 0) return null;
  return (
    <div className="mt-2.5 flex items-baseline gap-2 overflow-hidden">
      {scale.slice(0, 7).map((s, i) => (
        <span
          key={`${String(s)}-${String(i)}`}
          className="shrink-0 leading-none text-droid-text-secondary"
          style={{ fontSize: Math.max(9, Math.min(22, s)) }}
          title={`${String(s)}px`}
        >
          Aa
        </span>
      ))}
    </div>
  );
}

/** First family name out of a CSS font stack, for compact display. */
function family(stack: string): string {
  const first = stack
    .split(',')[0]
    ?.trim()
    .replace(/^["']|["']$/g, '');
  return first || stack;
}
