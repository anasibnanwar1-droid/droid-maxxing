import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';

/* ─────────────────────────────────────────────────────────────────────────
 * Rich <json-render> renderer.
 *
 * Agents emit a single-line JSON spec wrapped in <json-render>…</json-render>
 * tags to draw dashboards, charts, tables, etc. The spec shape is:
 *   { "root": "<id>", "elements": { "<id>": { type, props, children } } }
 * where `children` is an array of element-id strings.
 *
 * The renderer is intentionally lenient: models routinely place component
 * props as siblings of `type` instead of inside `props`, so we merge any
 * stray top-level keys into props before rendering.
 * ──────────────────────────────────────────────────────────────────────── */

const CELL = 8; // px per layout "cell" for padding/gap multipliers
const MAX_DEPTH = 50;
// Global expansion budget. `seen` only blocks cycles along a single ancestry
// path, so a shared-child DAG (a -> [b,b], b -> [c,c], ...) still fans out
// exponentially before MAX_DEPTH alone stops it. A shared node budget caps the
// total rendered elements so a small malicious/buggy spec can't freeze the UI.
const MAX_NODES = 1000;
// Collection props (chart data, table rows, list items) are capped before
// rendering: a huge array would not only spawn thousands of DOM nodes but can
// also blow the call stack via spread math like `Math.min(...data)` (a
// model-supplied `data` of 100k+ numbers throws RangeError and freezes chat).
const MAX_ITEMS = 2000;
const MAX_TABLE_COLUMNS = 40;

type RawElement = {
  type?: string;
  props?: Record<string, unknown>;
  children?: unknown;
  [key: string]: unknown;
};

type Spec = {
  root?: string;
  elements?: Record<string, RawElement>;
};

const COLOR_MAP: Record<string, string> = {
  accent: 'var(--droid-accent)',
  green: 'var(--droid-green)',
  success: 'var(--droid-green)',
  orange: 'var(--droid-orange)',
  warning: 'var(--droid-orange)',
  red: 'var(--droid-red)',
  error: 'var(--droid-red)',
  danger: 'var(--droid-red)',
  info: 'var(--droid-accent)',
  blue: 'var(--droid-accent)',
  muted: 'var(--droid-text-muted)',
  secondary: 'var(--droid-text-secondary)',
  text: 'var(--droid-text)',
  white: 'var(--droid-text)',
  gray: 'var(--droid-text-muted)',
  grey: 'var(--droid-text-muted)',
};

// Only allow our themed names plus literal hex/rgb/hsl/plain-word colors. This
// blocks CSS functions like url()/var()/image-set() from model-supplied specs
// from smuggling network requests or escaping the intended style.
const SAFE_COLOR_RE =
  /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([\d.,\s%/]+\)|hsla?\([\d.,\s%/]+\)|[a-z]+)$/i;

function resolveColor(c: unknown): string | undefined {
  if (typeof c !== 'string' || !c) return undefined;
  const trimmed = c.trim();
  const mapped = COLOR_MAP[trimmed.toLowerCase()];
  if (mapped) return mapped;
  return SAFE_COLOR_RE.test(trimmed) ? trimmed : undefined;
}

function asString(v: unknown, fallback = ''): string {
  if (v == null) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]).slice(0, MAX_ITEMS) : [];
}

// Like asArray but drops entries that are not plain objects, so components can
// safely dereference fields (d.value, Object.keys(r), it.status) on specs that
// include null/primitive entries such as data: [null].
function asRecordArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v
        .filter(
          (e): e is Record<string, unknown> =>
            typeof e === 'object' && e !== null && !Array.isArray(e),
        )
        .slice(0, MAX_ITEMS)
    : [];
}

/* Merge stray top-level keys into props so malformed specs still render. */
function mergedProps(el: RawElement): Record<string, unknown> {
  const { type: _t, props, children: _c, ...rest } = el;
  void _t;
  void _c;
  return { ...rest, ...(props && typeof props === 'object' ? props : {}) };
}

// Semantic status → themed color. success/warning/error use the fixed semantic
// green/amber/red so they always read by hue, even in monochrome; only info
// follows the neutral accent so it stays part of the monochrome UI chrome.
const STATUS_COLOR: Record<string, string> = {
  success: 'var(--droid-green)',
  error: 'var(--droid-red)',
  warning: 'var(--droid-orange)',
  info: 'var(--droid-accent)',
};

// Look up by own-property only: a model-supplied status like "constructor" or
// "toString" would otherwise resolve through Object.prototype to a truthy value
// and slip past the map, so guard against prototype keys explicitly.
function statusColor(key: string, fallback = 'var(--droid-text-muted)'): string {
  return Object.prototype.hasOwnProperty.call(STATUS_COLOR, key) ? STATUS_COLOR[key] : fallback;
}

/* ── individual components ── */

function BoxEl({ props, children }: { props: Record<string, unknown>; children: ReactNode }) {
  const row = props.flexDirection === 'row';
  const padding = asNumber(props.padding);
  const gap = asNumber(props.gap);
  const bordered = !!props.borderStyle;
  return (
    <div
      className={bordered ? 'rounded-xl border border-droid-border' : undefined}
      style={{
        display: 'flex',
        flexDirection: row ? 'row' : 'column',
        flexWrap: row ? 'wrap' : undefined,
        alignItems: row ? 'stretch' : undefined,
        gap: gap != null ? gap * CELL : undefined,
        padding: padding != null ? padding * CELL : undefined,
      }}
    >
      {children}
    </div>
  );
}

function TextEl({ props }: { props: Record<string, unknown> }) {
  return (
    <span
      className="text-[13px] leading-relaxed break-words"
      style={{ color: resolveColor(props.color), fontWeight: props.bold ? 600 : undefined }}
    >
      {asString(props.text)}
    </span>
  );
}

function HeadingEl({ props }: { props: Record<string, unknown> }) {
  const level = asString(props.level, 'h2').toLowerCase();
  const text = asString(props.text);
  const cls =
    level === 'h1'
      ? 'text-[17px] font-semibold'
      : level === 'h3'
        ? 'text-[13.5px] font-semibold text-droid-text-secondary'
        : 'text-[15px] font-semibold';
  return <div className={`${cls} text-droid-text break-words`}>{text}</div>;
}

function DividerEl({ props }: { props: Record<string, unknown> }) {
  const title = asString(props.title);
  if (!title) return <div className="h-px bg-droid-border/70 my-1" />;
  return (
    <div className="flex items-center gap-2.5 my-1 text-droid-text-muted">
      <div className="h-px flex-1 bg-droid-border/70" />
      <span className="text-[11px] tracking-wide uppercase whitespace-nowrap">{title}</span>
      <div className="h-px flex-1 bg-droid-border/70" />
    </div>
  );
}

function BarChartEl({ props }: { props: Record<string, unknown> }) {
  const data = asRecordArray(props.data);
  const showPct = !!props.showPercentage;
  const max = Math.max(1, ...data.map((d) => asNumber(d.value) ?? 0));
  const total = data.reduce((s, d) => s + (asNumber(d.value) ?? 0), 0) || 1;
  return (
    <div className="flex flex-col gap-1.5 w-full">
      {data.map((d, i) => {
        const value = asNumber(d.value) ?? 0;
        const color = resolveColor(d.color) ?? 'var(--droid-accent)';
        const label = showPct ? `${Math.round((value / total) * 100)}%` : String(value);
        return (
          <div key={i} className="flex items-center gap-2 text-[12px]">
            <span className="w-24 shrink-0 truncate text-droid-text-secondary text-right">
              {asString(d.label)}
            </span>
            <div className="flex-1 h-3.5 rounded-sm bg-droid-elevated/60 overflow-hidden">
              <div
                className="h-full rounded-sm"
                style={{ width: `${(value / max) * 100}%`, backgroundColor: color }}
              />
            </div>
            <span className="w-12 shrink-0 font-mono text-droid-text-muted">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function SparklineEl({ props }: { props: Record<string, unknown> }) {
  const data = asArray(props.data).map((v) => asNumber(v) ?? 0);
  const color = resolveColor(props.color) ?? 'var(--droid-accent)';
  const min = Math.min(...data, 0);
  const max = Math.max(...data, 1);
  const span = max - min || 1;
  return (
    <div className="inline-flex items-end gap-px h-6 align-middle">
      {data.map((v, i) => (
        <div
          key={i}
          className="w-1 rounded-sm"
          style={{ height: `${Math.max(8, ((v - min) / span) * 100)}%`, backgroundColor: color }}
        />
      ))}
    </div>
  );
}

function TableEl({ props }: { props: Record<string, unknown> }) {
  const columns = asRecordArray(props.columns).slice(0, MAX_TABLE_COLUMNS);
  const rows = asRecordArray(props.rows);
  const headerColor = resolveColor(props.headerColor);
  // Fall back to row keys when columns are omitted.
  const cols: Record<string, unknown>[] = columns.length
    ? columns
    : Array.from(new Set(rows.flatMap((r) => Object.keys(r))))
        .slice(0, MAX_TABLE_COLUMNS)
        .map((key) => ({ header: key, key }));
  return (
    <div className="overflow-x-auto rounded-xl border border-droid-border w-full">
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="bg-droid-elevated/25">
          <tr>
            {cols.map((c, i) => (
              <th
                key={i}
                className="border-b border-droid-border text-left align-top font-medium whitespace-nowrap px-2.5 py-1.5"
                style={{ color: headerColor ?? 'var(--droid-text)', width: asNumber(c.width) }}
              >
                {asString(c.header ?? c.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {cols.map((c, ci) => (
                <td
                  key={ci}
                  className="border-t border-droid-border align-top text-droid-text-secondary first:whitespace-nowrap first:pr-4 first:font-medium first:text-droid-text px-2.5 py-1.5"
                >
                  {asString(r[asString(c.key)])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListEl({ props }: { props: Record<string, unknown> }) {
  const items = asArray(props.items).map((v) => asString(v));
  const cls = 'marker:text-droid-text-muted pl-5 space-y-1 text-[13px] text-droid-text';
  return props.ordered ? (
    <ol className={`list-decimal ${cls}`}>
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ol>
  ) : (
    <ul className={`list-disc ${cls}`}>
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

function CardEl({ props, children }: { props: Record<string, unknown>; children: ReactNode }) {
  const title = asString(props.title);
  const padding = asNumber(props.padding);
  return (
    <div className="rounded-xl border border-droid-border bg-droid-elevated/20 overflow-hidden w-full">
      {title && (
        <div className="px-3.5 py-2 border-b border-droid-border text-[12px] font-medium text-droid-text">
          {title}
        </div>
      )}
      <div style={{ padding: (padding != null ? padding : 1.5) * CELL }}>{children}</div>
    </div>
  );
}

function StatusLineEl({ props }: { props: Record<string, unknown> }) {
  const status = asString(props.status, 'info').toLowerCase();
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-droid-text">
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: statusColor(status) }}
      />
      {asString(props.text)}
    </span>
  );
}

function KeyValueEl({ props }: { props: Record<string, unknown> }) {
  return (
    <div className="flex items-baseline gap-2 text-[13px]">
      <span className="text-droid-text-muted">{asString(props.label)}</span>
      <span className="text-droid-text font-medium break-words">{asString(props.value)}</span>
    </div>
  );
}

function BadgeEl({ props }: { props: Record<string, unknown> }) {
  const color = resolveColor(props.variant) ?? 'var(--droid-text-secondary)';
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border"
      style={{
        color,
        borderColor: color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      {asString(props.label)}
    </span>
  );
}

function ProgressBarEl({ props }: { props: Record<string, unknown> }) {
  const raw = asNumber(props.progress) ?? 0;
  const pct = Math.max(0, Math.min(1, raw)) * 100;
  const label = asString(props.label);
  return (
    <div className="flex flex-col gap-1 w-full">
      {label && (
        <div className="flex justify-between text-[12px] text-droid-text-secondary">
          <span>{label}</span>
          <span className="font-mono text-droid-text-muted">{Math.round(pct)}%</span>
        </div>
      )}
      <div className="h-2 rounded-full bg-droid-elevated/60 overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: 'var(--droid-accent)' }}
        />
      </div>
    </div>
  );
}

function MetricEl({ props }: { props: Record<string, unknown> }) {
  const trend = asString(props.trend).toLowerCase();
  const trendColor =
    trend === 'up' ? 'var(--droid-green)' : trend === 'down' ? 'var(--droid-red)' : undefined;
  const TrendIcon = trend === 'up' ? ArrowUp : trend === 'down' ? ArrowDown : null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-droid-text-muted">
        {asString(props.label)}
      </span>
      <span className="inline-flex items-center gap-1 text-[20px] font-semibold text-droid-text leading-tight">
        {asString(props.value)}
        {TrendIcon && <TrendIcon className="w-4 h-4" style={{ color: trendColor }} />}
      </span>
    </div>
  );
}

function CalloutEl({ props, children }: { props: Record<string, unknown>; children: ReactNode }) {
  const type = asString(props.type, 'info').toLowerCase();
  const color = statusColor(type);
  const title = asString(props.title);
  const content = asString(props.content);
  // A single colored dot carries the severity; the card itself is a plain
  // elevated surface so P-level/danger notes read as clean cards, not stickers.
  const indent = title ? 'pl-3.5' : '';
  return (
    <div className="w-full rounded-xl border border-droid-border bg-droid-elevated px-4 py-3">
      {title && (
        <div className="flex items-center gap-2 text-[13px] font-semibold text-droid-text break-words">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
          {title}
        </div>
      )}
      {content && (
        <div
          className={`text-[12.5px] leading-relaxed text-droid-text-secondary break-words ${title ? `mt-1.5 ${indent}` : ''}`}
        >
          {content}
        </div>
      )}
      {children && <div className={title ? `mt-1.5 ${indent}` : ''}>{children}</div>}
    </div>
  );
}

function TimelineEl({ props }: { props: Record<string, unknown> }) {
  const items = asRecordArray(props.items);
  return (
    <div className="flex flex-col">
      {items.map((it, i) => {
        const status = asString(it.status).toLowerCase();
        const dot = statusColor(status);
        const last = i === items.length - 1;
        return (
          <div key={i} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <span className="mt-1 w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />
              {!last && <span className="w-px flex-1 bg-droid-text-muted/30 my-1" />}
            </div>
            <div className={`flex flex-col gap-0.5 ${last ? '' : 'pb-3'}`}>
              <span className="text-[13px] font-medium text-droid-text">{asString(it.title)}</span>
              {asString(it.description) && (
                <span className="text-[12px] text-droid-text-secondary">
                  {asString(it.description)}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── element dispatch ── */

function renderElement(
  type: string,
  props: Record<string, unknown>,
  children: ReactNode,
): ReactNode {
  switch (type) {
    case 'Box':
      return <BoxEl props={props}>{children}</BoxEl>;
    case 'Text':
      return <TextEl props={props} />;
    case 'Heading':
      return <HeadingEl props={props} />;
    case 'Divider':
      return <DividerEl props={props} />;
    case 'Newline':
      return <br />;
    case 'Spacer':
      return <div style={{ flex: 1 }} />;
    case 'BarChart':
      return <BarChartEl props={props} />;
    case 'Sparkline':
      return <SparklineEl props={props} />;
    case 'Table':
      return <TableEl props={props} />;
    case 'List':
      return <ListEl props={props} />;
    case 'Card':
      return <CardEl props={props}>{children}</CardEl>;
    case 'StatusLine':
      return <StatusLineEl props={props} />;
    case 'KeyValue':
      return <KeyValueEl props={props} />;
    case 'Badge':
      return <BadgeEl props={props} />;
    case 'ProgressBar':
      return <ProgressBarEl props={props} />;
    case 'Metric':
      return <MetricEl props={props} />;
    case 'Callout':
      return <CalloutEl props={props}>{children}</CalloutEl>;
    case 'Timeline':
      return <TimelineEl props={props} />;
    default:
      return children ?? null;
  }
}

function renderNode(
  id: string,
  spec: Spec,
  seen: Set<string>,
  depth: number,
  budget: { count: number },
): ReactNode {
  if (depth > MAX_DEPTH || seen.has(id) || budget.count >= MAX_NODES) return null;
  budget.count++;
  const el = spec.elements?.[id];
  if (!el || typeof el !== 'object') return null;
  const props = mergedProps(el);
  const childIds = asArray(el.children ?? props.children).filter(
    (c): c is string => typeof c === 'string',
  );
  const nextSeen = new Set(seen).add(id);
  const children = childIds.length
    ? childIds.map((cid, i) => (
        <Fragment key={`${cid}-${i}`}>
          {renderNode(cid, spec, nextSeen, depth + 1, budget)}
        </Fragment>
      ))
    : null;
  return renderElement(asString(el.type), props, children);
}

function ErrorFallback({ raw }: { raw: string }) {
  return (
    <div className="rounded-xl border border-droid-border bg-droid-elevated/20 overflow-hidden my-2.5">
      <div className="px-3.5 h-7 flex items-center text-[10px] font-medium tracking-widest uppercase text-droid-text-muted/60 border-b border-droid-border">
        Render spec (unparseable)
      </div>
      <pre className="overflow-x-auto p-3.5">
        <code className="font-mono text-[12px] text-droid-text-secondary whitespace-pre">
          {raw}
        </code>
      </pre>
    </div>
  );
}

export const JsonRender = memo(function JsonRender({ source }: { source: string }) {
  const parsed = useMemo<Spec | null>(() => {
    try {
      const obj = JSON.parse(source.trim());
      return obj && typeof obj === 'object' ? (obj as Spec) : null;
    } catch {
      return null;
    }
  }, [source]);

  if (!parsed || !parsed.elements || !parsed.root) {
    return <ErrorFallback raw={source.trim()} />;
  }

  const tree = renderNode(parsed.root, parsed, new Set(), 0, { count: 0 });
  if (tree == null) return <ErrorFallback raw={source.trim()} />;

  return <div className="my-2.5 w-full max-w-full break-words">{tree}</div>;
});

/* ── splitting helper for message bodies ── */

export type ContentSegment =
  | { type: 'markdown'; value: string }
  | { type: 'json-render'; value: string };

const JSON_RENDER_RE = /<json-render>([\s\S]*?)<\/json-render>/g;

export function splitJsonRender(text: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  JSON_RENDER_RE.lastIndex = 0;
  while ((match = JSON_RENDER_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'markdown', value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'json-render', value: match[1] });
    lastIndex = match.index + match[0].length;
  }

  let tail = text.slice(lastIndex);
  // A still-streaming render has an opening tag without a close: hide the partial
  // JSON rather than dumping it as raw text, and keep any text before it. Only do
  // this when the tag is genuinely starting a render block (its JSON has begun);
  // a literal mention in prose like "use <json-render> tags" is kept as-is.
  const openIdx = tail.indexOf('<json-render>');
  if (openIdx !== -1) {
    const after = tail.slice(openIdx + '<json-render>'.length).trimStart();
    if (after.startsWith('{')) tail = tail.slice(0, openIdx);
  }
  if (tail) segments.push({ type: 'markdown', value: tail });

  return segments;
}

export function hasJsonRender(text: string): boolean {
  return text.includes('<json-render>');
}

export const __resolveColorForTest = resolveColor;
export const __statusColorForTest = statusColor;

// Test seam: render a spec and report how many nodes were actually expanded, so
// the global budget can be asserted without a DOM. Returns at most MAX_NODES.
export function __renderBudgetForTest(spec: Spec): number {
  const budget = { count: 0 };
  renderNode(spec.root ?? '', spec, new Set(), 0, budget);
  return budget.count;
}
export const __MAX_NODES_FOR_TEST = MAX_NODES;
