import { useMemo, useState, memo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, Terminal, Copy, Check, FileText, Expand as ExpandIcon, FoldVertical, MousePointer2, PenLine } from 'lucide-react';
import type { BrowserTranscriptReference, TranscriptEvent } from '../types/bridge';
import { Markdown } from './Markdown';
import { JsonRender, splitJsonRender, hasJsonRender } from './JsonRender';
import { extractFileChange, type FileChange } from '../lib/diff';
import { DiffCard } from './DiffView';
import { CAT_LABEL, toolMeta, safeJson, stripAnsi, formatDuration, isSubagentTool, subagentInfo } from '../lib/tools';

const ACCENT = 'var(--droid-accent)';
const EASE = [0.16, 1, 0.3, 1] as const;

/* ── Live elapsed-time hook: ticks once per second while `active`. ── */
function useElapsed(startTs: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return startTs != null ? Math.max(0, now - startTs) : 0;
}

/* ── Streaming caret (text being written) ── */
export function StreamingCaret() {
  return (
    <motion.span
      className="inline-block w-[2px] h-[1.05em] -mb-[0.15em] ml-0.5 rounded-sm align-baseline"
      style={{ background: ACCENT }}
      animate={{ opacity: [1, 0.15, 1] }}
      transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

/* ── Working indicator — minimal shimmer label, no icons/dots/bars ── */
export function WorkingIndicator({ label = 'Working', startTs }: { label?: string; startTs?: number }) {
  const elapsed = useElapsed(startTs, true);
  const suffix = startTs != null && elapsed >= 1000 ? ` ${formatDuration(elapsed)}` : '';
  return <span className="shimmer-text text-[13px] font-medium tracking-tight" aria-live="polite">{label}{suffix}…</span>;
}

/* ── Compaction indicator — centered, larger shimmer while compacting ── */
export function CompactingIndicator() {
  return (
    <div className="flex justify-center py-3">
      <span className="shimmer-text text-[16px] font-semibold tracking-tight" aria-live="polite">Compacting…</span>
    </div>
  );
}

/* ── Compaction divider — persistent marker once compaction has completed ── */
export function CompactionDivider({ compactType }: { compactType?: 'auto' | 'manual' }) {
  const manual = compactType === 'manual';
  return (
    <div className={`flex items-center gap-3 py-1 ${manual ? 'text-droid-text-secondary' : 'text-droid-text-muted'}`}>
      <div className="h-px flex-1 bg-droid-border/70" />
      <span className="flex items-center gap-1.5 text-[12px] whitespace-nowrap">
        <FoldVertical className="h-3.5 w-3.5" />
        {manual ? 'Session compacted' : 'Context automatically compacted'}
      </span>
      <div className="h-px flex-1 bg-droid-border/70" />
    </div>
  );
}

// A status line that signals compaction is in progress (not the completion
// line). Match the active gerund ("Compacting conversation...") specifically so
// terminal lines ("Compaction complete.", "Nothing to compact.") and rejections
// ("Cannot compact while a turn is active.") don't keep the shimmer running.
export function isCompactingStatus(text?: string): boolean {
  const t = text ?? '';
  return /compacting/i.test(t) && !/complete/i.test(t);
}

// A status line that signals compaction finished.
export function isCompactionCompleteStatus(text?: string): boolean {
  const t = text ?? '';
  return /compact/i.test(t) && /complete/i.test(t);
}

/* ── Subtle expand affordance ── */
function Caret({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={`w-3 h-3 shrink-0 text-droid-text-muted/50 transition-transform duration-200 group-hover:text-droid-text-muted ${open ? 'rotate-90' : ''}`}
    />
  );
}

/* ── Animated expand/collapse, no chrome ── */
function Expand({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: EASE }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── Thinking / Thought ── */
function ThinkingItem({ text, durationMs, active, startTs }: { text: string; durationMs?: number; active?: boolean; startTs?: number }) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(startTs, !!active);
  const label = active
    ? elapsed >= 1000 ? `Thinking ${formatDuration(elapsed)}` : 'Thinking'
    : durationMs != null && durationMs >= 1000 ? `Thought for ${formatDuration(durationMs)}` : 'Thought';
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="group flex items-center gap-1.5 text-left">
        <Caret open={active ? true : open} />
        {active ? (
          <span className="shimmer-text text-[13px] font-medium">{label}</span>
        ) : (
          <span className="text-[13px] text-droid-text-muted group-hover:text-droid-text-secondary transition-colors">{label}</span>
        )}
      </button>
      <Expand open={active ? true : open}>
        <div className="mt-2 pl-[18px] text-[12.5px] text-droid-text-muted/55 leading-[1.7] whitespace-pre-wrap [overflow-wrap:anywhere]">
          {text}
          {active && <StreamingCaret />}
        </div>
      </Expand>
    </div>
  );
}

/* ── Condensed tool group: "Explored 4 files, 1 search" ── */
function summarizeTools(events: TranscriptEvent[]): string {
  const calls = events.filter((e) => e.kind === 'tool_call');
  if (calls.length === 0) return 'Tool result';
  const counts = { file: 0, search: 0, command: 0, page: 0, task: 0, step: 0 };
  let onlyExec = true;
  let onlyWeb = true;
  calls.forEach((e) => {
    const { cat } = toolMeta(e.toolName, e.toolArgs);
    if (cat !== 'exec') onlyExec = false;
    if (cat !== 'web') onlyWeb = false;
    if (cat === 'read') counts.file++;
    else if (cat === 'search') counts.search++;
    else if (cat === 'exec') counts.command++;
    else if (cat === 'web') counts.page++;
    else if (cat === 'task') counts.task++;
    else if (cat === 'skill') counts.step++;
    else counts.step++;
  });
  const parts: string[] = [];
  const add = (n: number, s: string, p: string) => { if (n > 0) parts.push(`${n} ${n === 1 ? s : p}`); };
  add(counts.file, 'file', 'files');
  add(counts.search, 'search', 'searches');
  add(counts.command, 'command', 'commands');
  add(counts.page, 'page', 'pages');
  add(counts.task, 'task', 'tasks');
  add(counts.step, 'step', 'steps');
  const verb = onlyExec ? 'Ran' : onlyWeb ? 'Fetched' : 'Explored';
  return `${verb} ${parts.join(', ')}`;
}

function argStr(args: unknown, key: string): string | undefined {
  if (args && typeof args === 'object') {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title="Copy"
      className="p-1 rounded-md text-droid-text-muted/60 hover:text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

/* ── Terminal-style command card ── */
function CommandCard({ command, output, title }: { command: string; output?: string; title?: string }) {
  const out = output ? stripAnsi(output).trimEnd() : '';
  return (
    <div className="rounded-xl bg-droid-bg/60 overflow-hidden ring-1 ring-droid-border">
      <div className="flex items-center gap-2 h-8 px-3 bg-droid-elevated/30">
        <Terminal className="w-3.5 h-3.5 text-droid-text-muted shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-droid-text-secondary">{title || 'Command'}</span>
        <CopyButton text={out ? `${command}\n\n${out}` : command} />
      </div>
      <div className="px-3 py-2.5 font-mono text-[11.5px] leading-[1.6]">
        <div className="flex gap-1.5 [overflow-wrap:anywhere]">
          <span className="select-none text-droid-text-muted/70">$</span>
          <span className="whitespace-pre-wrap text-droid-text-secondary">{command}</span>
        </div>
        {out && (
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-[1.55] text-droid-text-muted/80 [overflow-wrap:anywhere]">
            {out}
          </pre>
        )}
      </div>
    </div>
  );
}

function ToolLine({ event, output }: { event: TranscriptEvent; output?: string }) {
  const { cat, detail } = toolMeta(event.toolName, event.toolArgs);
  const out = output ? stripAnsi(output).trimEnd() : '';
  return (
    <div>
      <div className="text-[12.5px] leading-relaxed [overflow-wrap:anywhere]">
        <span className="text-droid-text-secondary">{CAT_LABEL[cat]}</span>
        {(detail || event.toolName) && (
          <span className="ml-1.5 font-mono text-[11.5px] text-droid-text-muted">{detail || event.toolName}</span>
        )}
      </div>
      {cat === 'other' && out && (
        <pre className="mt-1.5 max-h-44 overflow-auto rounded-md bg-droid-bg/50 px-2.5 py-2 text-[11px] leading-relaxed font-mono text-droid-text-muted/80 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {out}
        </pre>
      )}
    </div>
  );
}

function renderToolEvents(events: TranscriptEvent[]): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === 'tool_call') {
      const next = events[i + 1];
      const result = next && next.kind === 'tool_result' ? next : undefined;
      if (result) i++;
      const { cat, detail } = toolMeta(e.toolName, e.toolArgs);
      if (cat === 'exec') {
        const command = argStr(e.toolArgs, 'command') ?? argStr(e.toolArgs, 'cmd') ?? argStr(e.toolArgs, 'script') ?? detail ?? e.toolName ?? 'command';
        nodes.push(<CommandCard key={e.id} command={command} output={result?.text} title={argStr(e.toolArgs, 'summary')} />);
      } else {
        nodes.push(<ToolLine key={e.id} event={e} output={result?.text} />);
      }
      continue;
    }
    const body = stripAnsi(e.text ?? safeJson(e.toolArgs)).trimEnd();
    if (!body) continue;
    nodes.push(
      <pre key={e.id} className="max-h-48 overflow-auto rounded-md bg-droid-bg/50 px-2.5 py-2 text-[11px] leading-relaxed font-mono text-droid-text-muted/80 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {body}
      </pre>,
    );
  }
  return nodes;
}

function ToolGroupItem({ events, active }: { events: TranscriptEvent[]; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeTools(events);
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="group flex items-center gap-1.5 text-left">
        <Caret open={open} />
        {active ? (
          <span className="shimmer-text text-[13px] font-medium">{summary}</span>
        ) : (
          <span className="text-[13px] text-droid-text-muted group-hover:text-droid-text-secondary transition-colors">{summary}</span>
        )}
      </button>
      <Expand open={open}>
        <div className="mt-2 pl-[18px] space-y-2.5">{renderToolEvents(events)}</div>
      </Expand>
    </div>
  );
}

/* ── Feed model ── */
type FeedItem =
  | { type: 'message'; key: string; event: TranscriptEvent }
  | { type: 'thinking'; key: string; event: TranscriptEvent; durationMs?: number }
  | { type: 'status'; key: string; event: TranscriptEvent }
  | { type: 'error'; key: string; event: TranscriptEvent }
  | { type: 'diff'; key: string; event: TranscriptEvent; change: FileChange }
  | { type: 'diffs'; key: string; changes: { event: TranscriptEvent; change: FileChange }[] }
  | { type: 'subagent'; key: string; event: TranscriptEvent }
  | { type: 'tools'; key: string; events: TranscriptEvent[] }
  | { type: 'worked'; key: string; items: FeedItem[]; durationMs: number };

// A single Task spawn streams as many tool_call/tool_call_delta events sharing
// one toolUseId; keep whichever copy actually carries the droid name/description.
function richerSubagent(existing: TranscriptEvent, next: TranscriptEvent): TranscriptEvent {
  const e = subagentInfo(existing.toolArgs);
  const n = subagentInfo(next.toolArgs);
  if (!e.label && n.label) return next;
  if (e.label && !n.label) return existing;
  if (!e.description && n.description) return next;
  return existing;
}

function buildFeed(events: TranscriptEvent[], subagentCards = false): FeedItem[] {
  const items: FeedItem[] = [];
  // toolUseId → index of its spawn item, so streaming deltas collapse into one.
  const subagentIdx = new Map<string, number>();
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.author === 'user' || ev.kind === 'text') { items.push({ type: 'message', key: ev.id, event: ev }); i++; continue; }
    if (ev.kind === 'thinking') {
      const next = events[i + 1];
      const end = ev.endTs ?? next?.ts;
      items.push({ type: 'thinking', key: ev.id, event: ev, durationMs: end != null ? Math.max(0, end - ev.ts) : undefined });
      i++; continue;
    }
    if (ev.kind === 'status') { items.push({ type: 'status', key: ev.id, event: ev }); i++; continue; }
    if (ev.kind === 'error' || ev.isError) { items.push({ type: 'error', key: ev.id, event: ev }); i++; continue; }
    if (ev.kind === 'tool_call') {
      const change = extractFileChange(ev.toolName, ev.toolArgs);
      if (change) {
        // Fold a contiguous run of file edits into one collapsible group so a
        // large multi-file change doesn't bury the chat under dozens of cards.
        const changes: { event: TranscriptEvent; change: FileChange }[] = [{ event: ev, change }];
        i++;
        while (i < events.length && events[i].kind === 'tool_call') {
          const c = extractFileChange(events[i].toolName, events[i].toolArgs);
          if (!c) break;
          changes.push({ event: events[i], change: c });
          i++;
        }
        if (changes.length === 1) items.push({ type: 'diff', key: ev.id, event: ev, change });
        else items.push({ type: 'diffs', key: `diffs-${ev.id}`, changes });
        continue;
      }
      if (subagentCards && isSubagentTool(ev.toolName, ev.toolArgs)) {
        const key = ev.toolUseId ?? ev.id;
        const at = subagentIdx.get(key);
        if (at == null) {
          subagentIdx.set(key, items.length);
          items.push({ type: 'subagent', key: `subagent-${key}`, event: ev });
        } else {
          const cur = items[at] as Extract<FeedItem, { type: 'subagent' }>;
          items[at] = { ...cur, event: richerSubagent(cur.event, ev) };
        }
        i++;
        // Skip the subagent's successful completion tool_result so it doesn't
        // become an orphaned "Tool result" entry in the grouping block below.
        // Keep error results so a failed spawn surfaces instead of vanishing.
        if (i < events.length && events[i].kind === 'tool_result' && events[i].toolName === ev.toolName && !events[i].isError) i++;
        continue;
      }
    }
    if (ev.kind === 'tool_call' || ev.kind === 'tool_result') {
      const group: TranscriptEvent[] = [];
      while (i < events.length) {
        const t = events[i];
        if (t.kind === 'tool_result') { group.push(t); i++; continue; }
        // A subagent spawn must break the group so the outer loop can render it
        // as its own card instead of folding it into the generic tools group.
        if (subagentCards && t.kind === 'tool_call' && isSubagentTool(t.toolName, t.toolArgs)) break;
        if (t.kind === 'tool_call' && !extractFileChange(t.toolName, t.toolArgs)) { group.push(t); i++; continue; }
        break;
      }
      if (group.length) items.push({ type: 'tools', key: group[0].id, events: group });
      else i++;
      continue;
    }
    i++;
  }
  return items;
}

function isUserMessage(item: FeedItem): boolean {
  return item.type === 'message' && item.event.author === 'user';
}

// Best-effort end timestamp of a feed item, used to time the live working cue.
function tailTimestamp(item?: FeedItem): number | undefined {
  if (!item) return undefined;
  if (item.type === 'worked') return undefined;
  if (item.type === 'tools') { const e = item.events[item.events.length - 1]; return e?.endTs ?? e?.ts; }
  if (item.type === 'diffs') { const c = item.changes[item.changes.length - 1]; return c?.event.endTs ?? c?.event.ts; }
  return item.event.endTs ?? item.event.ts;
}

// Earliest start and latest end timestamps across a set of feed items.
function spanOf(items: FeedItem[]): { start: number; end: number } {
  let start = Infinity;
  let end = -Infinity;
  const consider = (ts?: number, endTs?: number) => {
    if (ts == null) return;
    start = Math.min(start, ts);
    end = Math.max(end, endTs ?? ts);
  };
  for (const it of items) {
    if (it.type === 'tools') it.events.forEach((e) => consider(e.ts, e.endTs));
    else if (it.type === 'diffs') it.changes.forEach((c) => consider(c.event.ts, c.event.endTs));
    else if (it.type !== 'worked') consider(it.event.ts, it.event.endTs);
  }
  if (start === Infinity) return { start: 0, end: 0 };
  return { start, end };
}

// Collapse a single completed assistant turn: everything except the concluding
// message folds into a "Worked for …" group (compaction steps included). While
// the turn is live it is never collapsed, so compaction stays visible then.
function collapseRun(run: FeedItem[]): FeedItem[] {
  if (run.length === 0) return [];
  const lastItem = run[run.length - 1];
  const conclusionIdx =
    lastItem.type === 'message' && lastItem.event.author !== 'user' ? run.length - 1 : -1;

  const work = conclusionIdx === -1 ? run : run.slice(0, conclusionIdx);
  const out: FeedItem[] = [];
  // Fold contiguous work into "Worked for …" groups, but keep subagent spawn
  // cards at the top level so they stay visible (and navigable) after a turn.
  let buf: FeedItem[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    const { start, end } = spanOf(buf);
    out.push({ type: 'worked', key: `worked-${buf[0].key}`, items: buf, durationMs: Math.max(0, end - start) });
    buf = [];
  };
  for (const it of work) {
    if (it.type === 'subagent') { flush(); out.push(it); }
    else if (it.type === 'status' && isCompactionCompleteStatus(it.event.text) && it.event.compactType === 'manual') { flush(); out.push(it); }
    else buf.push(it);
  }
  flush();
  if (conclusionIdx !== -1) out.push(run[conclusionIdx]);
  return out;
}

// Fold completed assistant turns into "Worked for …" groups. The in-flight turn
// (while pending) is left expanded so live thinking/tools/status keep streaming.
function groupTurns(items: FeedItem[], pending: boolean): FeedItem[] {
  const out: FeedItem[] = [];
  let i = 0;
  while (i < items.length) {
    if (isUserMessage(items[i])) {
      out.push(items[i]);
      i++;
      continue;
    }
    const run: FeedItem[] = [];
    while (i < items.length && !isUserMessage(items[i])) {
      run.push(items[i]);
      i++;
    }
    const isLastRun = i >= items.length;
    if (isLastRun && pending) out.push(...run);
    else out.push(...collapseRun(run));
  }
  return out;
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function BrowserReferenceChip({ reference }: { reference: BrowserTranscriptReference }) {
  const Icon = reference.kind === 'element' ? MousePointer2 : PenLine;
  return (
    <span
      title={reference.selector ? `${reference.selector}\n${reference.url ?? ''}` : reference.url ?? `Design reference: ${reference.label}`}
      className="flex min-w-0 items-center gap-1.5 rounded-lg bg-droid-accent/15 px-2 py-1 text-[11px] font-medium text-droid-text ring-1 ring-inset ring-droid-accent/30"
    >
      {reference.imageDataUrl ? (
        <img
          src={reference.imageDataUrl}
          alt={reference.label}
          className="h-5 max-w-12 rounded-sm object-cover"
        />
      ) : (
        <Icon className="h-3 w-3 shrink-0 text-droid-accent" />
      )}
      <span className="max-w-40 truncate">@{reference.label}</span>
    </span>
  );
}

function UserBubble({ event }: { event: TranscriptEvent }) {
  const skills = event.skills ?? [];
  const files = event.files ?? [];
  const browserRefs = event.browserRefs ?? [];
  const hasChips = skills.length > 0 || files.length > 0 || browserRefs.length > 0;
  return (
    <div className="flex flex-col items-end gap-1.5 py-1">
      {event.steered && (
        <span className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-droid-text-muted">
          <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
          Steered the conversation
        </span>
      )}
      {hasChips && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {browserRefs.map((reference) => (
            <BrowserReferenceChip key={`${reference.kind}:${reference.id}`} reference={reference} />
          ))}
          {files.map((f) => (
            <span
              key={f}
              title={f}
              className="flex items-center gap-1 rounded-lg border border-droid-border bg-droid-elevated/80 px-2 py-1 text-[11px] text-droid-text-secondary"
            >
              <FileText className="h-3 w-3 text-droid-text-muted" />
              {baseName(f)}
            </span>
          ))}
          {skills.map((s) => (
            <span
              key={s}
              title={`Skill: ${s}`}
              className="flex items-center rounded-lg bg-violet-500/15 px-2 py-1 text-[11px] font-medium text-violet-300 ring-1 ring-inset ring-violet-500/30"
            >
              {s}
            </span>
          ))}
        </div>
      )}
      {event.text && (
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-droid-elevated px-4 py-2.5 text-[14px] leading-relaxed text-droid-text whitespace-pre-wrap [overflow-wrap:anywhere]">
          {event.text}
        </div>
      )}
    </div>
  );
}

/* ── Collapsed spec card shown inline in chat (chevron to expand) ── */
const InlineSpecCard = memo(function InlineSpecCard({ content, onOpenWiki }: { content: string; onOpenWiki?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const title = useMemo(() => content.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() ?? 'Specification', [content]);
  const sections = useMemo(() => (content.match(/^#{1,3}\s+/gm) ?? []).length, [content]);

  return (
    <div className="rounded-xl border border-droid-border bg-droid-elevated/20 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left group"
        >
          <ChevronRight className={`w-4 h-4 shrink-0 text-droid-text-muted transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
          <FileText className="w-4 h-4 shrink-0 text-droid-text-muted" />
          <span className="truncate text-[13px] font-medium text-droid-text">{title}</span>
          {sections > 0 && (
            <span className="shrink-0 text-[11px] font-mono text-droid-text-muted/70">{sections} sections</span>
          )}
        </button>
        {onOpenWiki && (
          <button
            onClick={onOpenWiki}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-droid-text-secondary bg-droid-elevated/50 border border-droid-border hover:bg-droid-elevated/80 hover:text-droid-text transition-colors"
          >
            <ExpandIcon className="w-3.5 h-3.5" />
            Read spec
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: 'linear' }}
          >
            <div className="px-4 pb-4 pt-2 border-t border-droid-border">
              <Markdown specMode>{content}</Markdown>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/* ── Assistant message body: interleaves Markdown with <json-render> blocks ── */
const MessageBody = memo(function MessageBody({ text }: { text: string }) {
  if (!hasJsonRender(text)) return <Markdown>{text}</Markdown>;
  const segments = splitJsonRender(text);
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'json-render' ? (
          <JsonRender key={i} source={seg.value} />
        ) : seg.value.trim() ? (
          <Markdown key={i}>{seg.value}</Markdown>
        ) : null,
      )}
    </>
  );
});

const FeedItemView = memo(function FeedItemView({ item, live, compacting, onOpenDiff, onOpenSubagent, subagentActivity, liveTiming, specDraft, specContent }: {
  item: FeedItem;
  live: boolean;
  compacting?: boolean;
  onOpenDiff?: (c: FileChange) => void;
  onOpenSubagent?: (target: SubagentTarget) => void;
  subagentActivity?: (target: SubagentTarget) => SubagentActivity | undefined;
  liveTiming?: boolean;
  specDraft?: boolean;
  specContent?: string;
}) {
  switch (item.type) {
    case 'message': {
      if (item.event.author === 'user') return <UserBubble event={item.event} />;
      const text = item.event.text ?? '';
      // The spec lives in the pinned card, so hide its prose: while drafting we
      // suppress all assistant prose; afterwards only the exact spec block.
      if (specContent) {
        if (specDraft) return null;
        if (text.trim() && text.trim() === specContent.trim()) return null;
      }
      return (
        <div className="group/msg">
          <MessageBody text={text} />
          {live ? (
            <StreamingCaret />
          ) : (
            text.trim() && (
              <div className="mt-1.5 -ml-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity">
                <CopyButton text={text} />
              </div>
            )
          )}
        </div>
      );
    }
    case 'thinking':
      return <ThinkingItem text={item.event.text ?? ''} durationMs={item.durationMs} active={live} startTs={liveTiming ? item.event.ts : undefined} />;
    case 'subagent':
      return (
        <SubagentLine
          event={item.event}
          active={live}
          onOpen={onOpenSubagent}
          activity={subagentActivity?.({ toolUseId: item.event.toolUseId, label: subagentInfo(item.event.toolArgs).label })}
        />
      );
    case 'status': {
      const text = item.event.text ?? '';
      if (compacting) return <CompactingIndicator />;
      if (isCompactionCompleteStatus(text)) return <CompactionDivider compactType={item.event.compactType} />;
      return live ? (
        <span className="shimmer-text text-[13px] font-medium">{text}</span>
      ) : (
        <span className="block text-[13px] text-droid-text-muted leading-relaxed [overflow-wrap:anywhere]">{text}</span>
      );
    }
    case 'error':
      return (
        <div className="text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" style={{ color: ACCENT }}>
          {item.event.text}
        </div>
      );
    case 'diff':
      return <DiffCard change={item.change} onOpen={onOpenDiff ? () => onOpenDiff(item.change) : undefined} />;
    case 'diffs':
      return <DiffGroup changes={item.changes} onOpenDiff={onOpenDiff} />;
    case 'tools':
      return <ToolGroupItem events={item.events} active={live} />;
    case 'worked':
      return <WorkedGroup item={item} onOpenDiff={onOpenDiff} onOpenSubagent={onOpenSubagent} subagentActivity={subagentActivity} specDraft={specDraft} specContent={specContent} />;
  }
});

/* ── Worked-for group: a completed turn's steps folded into one disclosure ── */
function WorkedGroup({ item, onOpenDiff, onOpenSubagent, subagentActivity, specDraft, specContent }: {
  item: Extract<FeedItem, { type: 'worked' }>;
  onOpenDiff?: (c: FileChange) => void;
  onOpenSubagent?: (target: SubagentTarget) => void;
  subagentActivity?: (target: SubagentTarget) => SubagentActivity | undefined;
  specDraft?: boolean;
  specContent?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="group flex items-center gap-1.5 text-left">
        <span className="text-[13px] text-droid-text-muted group-hover:text-droid-text-secondary transition-colors">
          Worked for {formatDuration(item.durationMs)}
        </span>
        <Caret open={open} />
      </button>
      <Expand open={open}>
        <div className="mt-3 space-y-4 border-l border-droid-border pl-4">
          {item.items.map((child) => (
            <FeedItemView
              key={child.key}
              item={child}
              live={false}
              onOpenDiff={onOpenDiff}
              onOpenSubagent={onOpenSubagent}
              subagentActivity={subagentActivity}
              specDraft={specDraft}
              specContent={specContent}
            />
          ))}
        </div>
      </Expand>
    </div>
  );
}

/* ── Folded run of file edits: one collapsible header over individual diffs ── */
function DiffGroup({ changes, onOpenDiff }: {
  changes: { event: TranscriptEvent; change: FileChange }[];
  onOpenDiff?: (c: FileChange) => void;
}) {
  const [open, setOpen] = useState(false);
  const added = changes.reduce((s, c) => s + c.change.added, 0);
  const removed = changes.reduce((s, c) => s + c.change.removed, 0);
  const files = new Set(changes.map((c) => c.change.path));
  const label = files.size <= 1
    ? `Edited ${baseName(changes[0].change.path)} · ${changes.length} edits`
    : `Edited ${files.size} files · ${changes.length} edits`;
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="group flex w-full min-w-0 items-center gap-1.5 text-left">
        <ChevronRight className={`w-3 h-3 shrink-0 text-droid-text-muted/50 transition-transform duration-200 group-hover:text-droid-text-muted ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 truncate text-[13px] font-medium text-droid-text-muted group-hover:text-droid-text-secondary">{label}</span>
        <span className="ml-auto text-[11px] font-mono shrink-0" style={{ color: '#5cc89a' }}>+{added}</span>
        <span className="text-[11px] font-mono shrink-0" style={{ color: '#ff7a5c' }}>−{removed}</span>
      </button>
      <Expand open={open}>
        <div className="mt-2 space-y-2 border-l border-droid-border pl-3">
          {changes.map((c) => (
            <DiffCard key={c.event.id} change={c.change} onOpen={onOpenDiff ? () => onOpenDiff(c.change) : undefined} />
          ))}
        </div>
      </Expand>
    </div>
  );
}

/* ── Per-agent name color: deterministic pick so each droid keeps one hue ── */
const SUBAGENT_COLORS = ['#e0a458', '#6ea8fe', '#5cc8a8', '#c58af9', '#e8728f', '#7bd88f', '#f0a06a', '#9d8cff'] as const;
function subagentColor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return SUBAGENT_COLORS[h % SUBAGENT_COLORS.length];
}

export type SubagentTarget = { toolUseId?: string; label?: string };
export type SubagentActivity = {
  status?: 'running' | 'paused' | 'completed';
  startedAt?: number;
  latest?: { kind: TranscriptEvent['kind']; text?: string; toolName?: string; toolArgs?: unknown };
};

// Last non-empty line, capped, so a long thinking block stays a one-line cue.
function previewLine(text?: string): string | undefined {
  if (!text) return undefined;
  const line = text.trim().split('\n').filter(Boolean).pop() ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line || undefined;
}

// Map the subagent's newest transcript event to a short head + body, mirroring
// how the main feed labels thinking/tool steps.
function subagentLatest(latest: SubagentActivity['latest']): { head: string; body?: string } | null {
  if (!latest) return null;
  switch (latest.kind) {
    case 'thinking':
      return { head: 'Thinking', body: previewLine(latest.text) };
    case 'tool_call': {
      const { cat, detail } = toolMeta(latest.toolName, latest.toolArgs);
      return { head: CAT_LABEL[cat], body: detail || latest.toolName };
    }
    case 'text':
      return { head: 'Responding', body: previewLine(latest.text) };
    case 'error':
      return { head: 'Error', body: previewLine(latest.text) };
    case 'status':
      return { head: 'Working', body: previewLine(latest.text) };
    default:
      return { head: 'Working', body: previewLine(latest.text) };
  }
}

/* ── In-chat spawned subagent: inline thinking-style line + click to navigate ── */
function SubagentLine({ event, active, onOpen, activity }: {
  event: TranscriptEvent;
  active?: boolean;
  onOpen?: (target: SubagentTarget) => void;
  activity?: SubagentActivity;
}) {
  const [open, setOpen] = useState(false);
  const { label, description } = subagentInfo(event.toolArgs);
  const name = label ?? 'subagent';
  const color = subagentColor(name);
  const running = activity?.status === 'running' || (!!active && activity?.status !== 'completed');
  const startTs = activity?.startedAt;
  const elapsed = useElapsed(startTs, running);
  const timer = running && startTs != null && elapsed >= 1000 ? formatDuration(elapsed) : '';
  const verb = running ? 'Running' : 'Spawned';
  // Append the literal "subagent" only when the name is a real droid label, so a
  // nameless spawn reads "Spawned subagent" instead of "Spawned subagent subagent".
  const tail = [label ? 'subagent' : '', timer].filter(Boolean).join(' ');
  const muted = running ? 'shimmer-text font-medium' : 'text-droid-text-muted';
  const latest = subagentLatest(activity?.latest);
  const navigate = () => onOpen?.({ toolUseId: event.toolUseId, label });
  return (
    <div>
      <div className="group flex items-center gap-1.5 text-[13px]">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center" aria-label="Toggle subagent activity">
          <Caret open={open} />
        </button>
        <span className={muted}>{verb}</span>
        <button
          type="button"
          onClick={navigate}
          className="font-semibold underline-offset-2 hover:underline"
          style={{ color }}
          title="Open subagent session"
        >
          {name}
        </button>
        {tail && <span className={muted}>{tail}</span>}
      </div>
      <Expand open={open}>
        <div className="mt-2 pl-[18px]">
          {description && (
            <div className="text-[12.5px] text-droid-text-muted/70 leading-relaxed [overflow-wrap:anywhere]">{description}</div>
          )}
          {latest && (
            <div className="mt-1.5 text-[12.5px] leading-relaxed [overflow-wrap:anywhere]">
              <span className={running ? 'shimmer-text font-medium' : 'text-droid-text-secondary font-medium'}>{latest.head}</span>
              {latest.body && <span className="ml-1.5 font-mono text-[11.5px] text-droid-text-muted/80">{latest.body}</span>}
            </div>
          )}
          {!latest && (
            <div className="mt-1.5 text-[12px] text-droid-text-muted/60">No activity captured yet.</div>
          )}
          <button
            type="button"
            onClick={navigate}
            className="mt-2 inline-flex items-center gap-1 text-[12px] text-droid-text-muted transition-colors hover:text-droid-text"
          >
            Open session
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </Expand>
    </div>
  );
}

/* ── The activity feed (list only; parent owns the scroll container) ── */
export function MessageFeed({ events, pending, onOpenDiff, onOpenSubagent, subagentActivity, specDraft, specContent, onOpenSpecWiki }: {
  events: TranscriptEvent[];
  pending: boolean;
  onOpenDiff?: (c: FileChange) => void;
  onOpenSubagent?: (target: SubagentTarget) => void;
  subagentActivity?: (target: SubagentTarget) => SubagentActivity | undefined;
  specDraft?: boolean;
  specContent?: string;
  onOpenSpecWiki?: () => void;
}) {
  // Subagent cards, waiting label, and live timers are enabled only for the
  // chat/spec feed (which supplies onOpenSubagent). Mission Control omits the
  // prop, so its feed renders exactly as before.
  const rich = !!onOpenSubagent;
  const items = useMemo(() => groupTurns(buildFeed(events, rich), pending), [events, pending, rich]);
  const lastIdx = items.length - 1;
  const last = items[lastIdx];
  const showSpecCard = (specContent?.length ?? 0) > 0;

  // Compaction is in progress when the latest status line announces it and no
  // completion line has arrived yet. Drives the centered "Compacting…" shimmer.
  const compacting = last?.type === 'status' && isCompactingStatus(last.event.text);

  // The tail already animates its own shimmer/caret for these; otherwise show an explicit cue.
  // A subagent line self-indicates too: it shows its own "Running … <timer>".
  const tailSelfIndicates =
    !!last &&
    (last.type === 'thinking' ||
      last.type === 'status' ||
      last.type === 'subagent' ||
      (last.type === 'message' && last.event.author !== 'user'));
  const showWorking = pending && !tailSelfIndicates;
  const workingLabel = last?.type === 'tools' ? 'Running' : (last?.type === 'diff' || last?.type === 'diffs') ? 'Updating files' : 'Working';
  const workingStart = rich ? tailTimestamp(last) : undefined;

  return (
    <div className="space-y-4">
      {showSpecCard && (
        <InlineSpecCard content={specContent ?? ''} onOpenWiki={onOpenSpecWiki} />
      )}

      {items.map((item, idx) => (
        <motion.div
          key={item.key}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: EASE }}
        >
          <FeedItemView
            item={item}
            live={pending && idx === lastIdx}
            compacting={compacting && idx === lastIdx}
            onOpenDiff={onOpenDiff}
            onOpenSubagent={onOpenSubagent}
            subagentActivity={subagentActivity}
            liveTiming={rich}
            specDraft={specDraft}
            specContent={specContent}
          />
        </motion.div>
      ))}

      {showWorking && <WorkingIndicator label={workingLabel} startTs={workingStart} />}
    </div>
  );
}
