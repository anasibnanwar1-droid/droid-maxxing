import { useMemo, useState, memo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, Terminal, Copy, Check, FileText, Expand as ExpandIcon, FoldVertical } from 'lucide-react';
import type { TranscriptEvent } from '../types/bridge';
import { Markdown } from './Markdown';
import { SpecModal } from './SpecModal';
import { extractFileChange, type FileChange } from '../lib/diff';
import { DiffCard } from './DiffView';
import { CAT_LABEL, toolMeta, safeJson, stripAnsi, formatDuration } from '../lib/tools';

const ACCENT = 'var(--droid-accent)';
const EASE = [0.16, 1, 0.3, 1] as const;

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
export function WorkingIndicator({ label = 'Working' }: { label?: string }) {
  return <span className="shimmer-text text-[13px] font-medium tracking-tight" aria-live="polite">{label}…</span>;
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
export function CompactionDivider() {
  return (
    <div className="flex items-center gap-3 py-1 text-droid-text-muted">
      <div className="h-px flex-1 bg-droid-border/70" />
      <span className="flex items-center gap-1.5 text-[12px] whitespace-nowrap">
        <FoldVertical className="h-3.5 w-3.5" />
        Context automatically compacted
      </span>
      <div className="h-px flex-1 bg-droid-border/70" />
    </div>
  );
}

// A status line that signals compaction is in progress (not the completion line).
export function isCompactingStatus(text?: string): boolean {
  const t = text ?? '';
  return /compact/i.test(t) && !/complete/i.test(t);
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
function ThinkingItem({ text, durationMs, active }: { text: string; durationMs?: number; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = active ? 'Thinking' : durationMs != null && durationMs >= 1000 ? `Thought for ${formatDuration(durationMs)}` : 'Thought';
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
        <div className="mt-2 pl-[18px] text-[12.5px] text-droid-text-muted/90 leading-[1.7] whitespace-pre-wrap [overflow-wrap:anywhere]">
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
    <div className="rounded-xl bg-droid-bg/60 overflow-hidden ring-1 ring-droid-border/60">
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
  | { type: 'tools'; key: string; events: TranscriptEvent[] }
  | { type: 'worked'; key: string; items: FeedItem[]; durationMs: number };

function buildFeed(events: TranscriptEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
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
      if (change) { items.push({ type: 'diff', key: ev.id, event: ev, change }); i++; continue; }
    }
    if (ev.kind === 'tool_call' || ev.kind === 'tool_result') {
      const group: TranscriptEvent[] = [];
      while (i < events.length) {
        const t = events[i];
        if (t.kind === 'tool_result') { group.push(t); i++; continue; }
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
  if (work.length > 0) {
    const { start, end } = spanOf(work);
    out.push({ type: 'worked', key: `worked-${work[0].key}`, items: work, durationMs: Math.max(0, end - start) });
  }
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

function UserBubble({ event }: { event: TranscriptEvent }) {
  const skills = event.skills ?? [];
  const files = event.files ?? [];
  const hasChips = skills.length > 0 || files.length > 0;
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
const InlineSpecCard = memo(function InlineSpecCard({ text, onOpenSpecModal }: { text: string; onOpenSpecModal?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const title = useMemo(() => text.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() ?? 'Specification', [text]);
  const sections = useMemo(() => (text.match(/^#{1,3}\s+/gm) ?? []).length, [text]);

  return (
    <div className="rounded-xl border border-droid-border/50 bg-droid-elevated/20 overflow-hidden">
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
        {onOpenSpecModal && (
          <button
            onClick={onOpenSpecModal}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-droid-text-secondary bg-droid-elevated/50 border border-droid-border/50 hover:bg-droid-elevated/80 hover:text-droid-text transition-colors"
          >
            <ExpandIcon className="w-3.5 h-3.5" />
            View Spec
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
            <div className="px-4 pb-4 pt-2 border-t border-droid-border/30">
              <Markdown specMode>{text}</Markdown>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

const FeedItemView = memo(function FeedItemView({ item, live, compacting, onOpenDiff, isSpec, specReady }: {
  item: FeedItem;
  live: boolean;
  compacting?: boolean;
  onOpenDiff?: (c: FileChange) => void;
  isSpec?: boolean;
  specReady?: boolean;
}) {
  switch (item.type) {
    case 'message': {
      if (item.event.author === 'user') return <UserBubble event={item.event} />;
      const text = item.event.text ?? '';
      // Once the spec is ready it's rendered as a single standalone card by
      // MessageFeed; collapse the draft prose so it isn't duplicated.
      if (isSpec && specReady) return null;
      return (
        <div>
          <Markdown specMode={isSpec}>{text}</Markdown>
          {live && <StreamingCaret />}
        </div>
      );
    }
    case 'thinking':
      return <ThinkingItem text={item.event.text ?? ''} durationMs={item.durationMs} active={live} />;
    case 'status': {
      const text = item.event.text ?? '';
      if (compacting) return <CompactingIndicator />;
      if (isCompactionCompleteStatus(text)) return <CompactionDivider />;
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
    case 'tools':
      return <ToolGroupItem events={item.events} active={live} />;
    case 'worked':
      return <WorkedGroup item={item} onOpenDiff={onOpenDiff} isSpec={isSpec} specReady={specReady} />;
  }
});

/* ── Worked-for group: a completed turn's steps folded into one disclosure ── */
function WorkedGroup({ item, onOpenDiff, isSpec, specReady }: {
  item: Extract<FeedItem, { type: 'worked' }>;
  onOpenDiff?: (c: FileChange) => void;
  isSpec?: boolean;
  specReady?: boolean;
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
        <div className="mt-3 space-y-4 border-l border-droid-border/60 pl-4">
          {item.items.map((child) => (
            <FeedItemView
              key={child.key}
              item={child}
              live={false}
              onOpenDiff={onOpenDiff}
              isSpec={isSpec}
              specReady={specReady}
            />
          ))}
        </div>
      </Expand>
    </div>
  );
}

/* ── The activity feed (list only; parent owns the scroll container) ── */
export function MessageFeed({ events, pending, onOpenDiff, isSpec, specContent, specReady }: {
  events: TranscriptEvent[];
  pending: boolean;
  onOpenDiff?: (c: FileChange) => void;
  isSpec?: boolean;
  specContent?: string;
  specReady?: boolean;
}) {
  const [specModalOpen, setSpecModalOpen] = useState(false);
  const openSpecModal = useCallback(() => setSpecModalOpen(true), []);
  const items = useMemo(() => groupTurns(buildFeed(events), pending), [events, pending]);
  const lastIdx = items.length - 1;
  const last = items[lastIdx];
  const showSpecCard = !!isSpec && !!specReady && (specContent?.length ?? 0) > 0;

  // Compaction is in progress when the latest status line announces it and no
  // completion line has arrived yet. Drives the centered "Compacting…" shimmer.
  const compacting = last?.type === 'status' && isCompactingStatus(last.event.text);

  // The tail already animates its own shimmer/caret for these; otherwise show an explicit cue.
  const tailSelfIndicates =
    !!last &&
    (last.type === 'thinking' ||
      last.type === 'status' ||
      (last.type === 'message' && last.event.author !== 'user'));
  const showWorking = pending && !tailSelfIndicates;
  const workingLabel = last?.type === 'tools' ? 'Running' : last?.type === 'diff' ? 'Updating files' : 'Working';

  return (
    <div className="space-y-4">
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
            isSpec={isSpec}
            specReady={specReady}
          />
        </motion.div>
      ))}

      {showSpecCard && (
        <InlineSpecCard text={specContent ?? ''} onOpenSpecModal={openSpecModal} />
      )}

      {showWorking && <WorkingIndicator label={workingLabel} />}

      <SpecModal
        open={specModalOpen}
        onClose={() => setSpecModalOpen(false)}
        content={specContent ?? ''}
      />
    </div>
  );
}
