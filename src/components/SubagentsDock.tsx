import { useEffect, useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { ChildSessionSummary, ChildStatus, ModelInfo } from '../types/bridge';
import {
  childSessionLabel,
  childSessionLatest,
  isPendingChildPlaceholder,
  orderedChildSessions,
  previewLine,
  type ChildSessionActivity,
  type ChildSessionTarget,
} from '../lib/childSessions';
import { formatDuration } from '../lib/tools';
import { ModelIcon, providerOf } from './ModelIcon';

/* One grouping card for a turn's subagent spawns, anchored where the first
   per-spawn feed line used to render. MessageFeed only renders it when the
   caller passes `subagentsDock`, so Mission Control keeps the inline lines. */

export interface SubagentsDockData {
  sessions: ChildSessionSummary[];
  models: ModelInfo[];
}

interface SubagentsDockProps extends SubagentsDockData {
  // True only while this wave's turn is still streaming. It gates every ticking
  // clock: once the turn ends (or the user stops it) the card must stop counting
  // instead of accruing time forever against a run nobody is watching.
  live?: boolean;
  onOpen?: (target: ChildSessionTarget) => void;
  activity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined;
}

/** Live runtime activity, when resolvable, wins over the store's last-known status. */
function resolveSubagentStatus(
  child: ChildSessionSummary,
  activity?: ChildSessionActivity,
): ChildStatus {
  return activity?.status ?? child.status;
}

function countSubagentStatuses(statuses: readonly ChildStatus[]): Record<ChildStatus, number> {
  const counts: Record<ChildStatus, number> = { pending: 0, running: 0, paused: 0, completed: 0 };
  for (const status of statuses) counts[status] += 1;
  return counts;
}

const STATUS_ORDER: readonly ChildStatus[] = ['running', 'paused', 'pending', 'completed'];

// Soft tint pills; completed stays an outline pill.
const STATUS_META: Record<ChildStatus, { label: string; className: string }> = {
  running: { label: 'Running', className: 'bg-droid-green/15 text-droid-green' },
  paused: { label: 'Idle', className: 'bg-droid-orange/15 text-droid-orange' },
  pending: { label: 'Queued', className: 'bg-droid-border/40 text-droid-text-secondary' },
  completed: {
    label: 'Done',
    className: 'border border-droid-border text-droid-text-muted',
  },
};

// Progress segments echo the pill colors: solid once done, tinted while alive.
const SEGMENT_TINT: Record<ChildStatus, string> = {
  running: 'bg-droid-green/40',
  paused: 'bg-droid-orange/40',
  pending: 'bg-droid-border/50',
  completed: 'bg-droid-green',
};

interface RowLatest {
  head: string;
  body?: string;
}

interface SubagentRow {
  child: ChildSessionSummary;
  status: ChildStatus;
  startedAt?: number;
  latest?: RowLatest;
  target?: ChildSessionTarget;
}

function buildRows(
  sessions: ChildSessionSummary[],
  activity?: (target: ChildSessionTarget) => ChildSessionActivity | undefined,
): SubagentRow[] {
  return orderedChildSessions(sessions).map((child) => {
    // Only tool-use spawn links resolve against the parent's transcript targets.
    const target: ChildSessionTarget | undefined =
      child.spawnLink?.kind === 'tool-use'
        ? { toolUseId: child.spawnLink.id, label: child.label }
        : undefined;
    const resolved = target ? activity?.(target) : undefined;
    return {
      child,
      status: resolveSubagentStatus(child, resolved),
      // The wave already resolved the true start (the spawn event, which precedes
      // the store's registration stamp), so it wins over the runtime's copy.
      startedAt: child.startedAt ?? resolved?.startedAt,
      latest: childSessionLatest(resolved?.latest) ?? undefined,
      target,
    };
  });
}

// Ticks once per second while any subagent may still accrue time.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [active]);
  return now;
}

// Rows are keyed by the spawn's tool-use id, which survives the placeholder →
// registered-session swap (the placeholder's childSessionId does not), so the
// row element and its timer stay put across the swap.
function rowKey(row: SubagentRow): string {
  return row.target?.toolUseId ?? row.child.childSessionId;
}

// The bridge reports startedAt but no completedAt, so a finished child's final
// duration is frozen the first time it is observed settled after having been
// live — settled meaning the child completed or its turn stopped streaming. A
// child already settled on first render (history replay) shows no timer,
// matching the old spawn lines. Bookkeeping lives in state updated from an
// effect; render only reads it.
function useRowDurationMs(rows: SubagentRow[], now: number, live: boolean): (number | undefined)[] {
  // id → {} once observed live, then { frozenMs } once its completion is seen.
  const [timings, setTimings] = useState<ReadonlyMap<string, { frozenMs?: number }>>(
    () => new Map(),
  );
  useEffect(() => {
    setTimings((prev) => {
      let next: Map<string, { frozenMs?: number }> | undefined;
      for (const row of rows) {
        const id = rowKey(row);
        const entry = prev.get(id);
        if (live && row.status !== 'completed') {
          if (!entry) (next ??= new Map(prev)).set(id, {});
        } else if (entry && entry.frozenMs == null && row.startedAt != null) {
          (next ??= new Map(prev)).set(id, { frozenMs: Math.max(0, Date.now() - row.startedAt) });
        }
      }
      return next ?? prev;
    });
  }, [rows, live]);
  return rows.map((row) => {
    if (row.startedAt == null) return undefined;
    // A subagent that never started has no run to time; showing one next to
    // "Queued" would claim work that never happened.
    if (row.status === 'pending') return undefined;
    if (row.status === 'completed' || !live) {
      const entry = timings.get(rowKey(row));
      // Until the freeze effect lands, show the still-current elapsed value.
      return entry ? (entry.frozenMs ?? Math.max(0, now - row.startedAt)) : undefined;
    }
    return row.status === 'running' ? Math.max(0, now - row.startedAt) : undefined;
  });
}

function StatusPill({
  status,
  count,
  className = '',
}: {
  status: ChildStatus;
  count?: number;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ${meta.className} ${className}`}
    >
      {count != null ? `${String(count)} ` : ''}
      {meta.label}
    </span>
  );
}

export function SubagentsDock({
  sessions,
  models,
  live = false,
  onOpen,
  activity,
}: SubagentsDockProps) {
  const [expanded, setExpanded] = useState(false);
  const reduceMotion = useReducedMotion();
  const bodyId = useId();

  const rows = buildRows(sessions, activity);
  const counts = countSubagentStatuses(rows.map((row) => row.status));
  const working = counts.running + counts.pending;
  const now = useNow(live && working > 0);
  const durationMs = useRowDurationMs(rows, now, live);

  if (rows.length === 0) return null;

  const allDone = counts.completed === rows.length;
  // Work is only *in flight* while the turn streams; afterwards the card is a
  // settled record, so nothing animates and nothing counts up.
  const inFlight = live && working > 0;
  const started = rows.map((row) => row.startedAt).filter((t): t is number => t != null);
  const firstStartedAt = started.length > 0 ? Math.min(...started) : undefined;
  const lastSettledAt = rows.reduce<number | undefined>((last, row, i) => {
    const ms = durationMs[i];
    if (row.startedAt == null || ms == null) return last;
    const settledAt = row.startedAt + ms;
    return last == null || settledAt > last ? settledAt : last;
  }, undefined);
  // One definition of the wave's time, ticking or settled: wall clock from the
  // first spawn to the last subagent settling. Summing the runs would invent
  // time a parallel wave never took.
  const timeMs =
    firstStartedAt == null
      ? undefined
      : inFlight
        ? Math.max(0, now - firstStartedAt)
        : lastSettledAt != null
          ? Math.max(0, lastSettledAt - firstStartedAt)
          : undefined;
  const progress = counts.completed / rows.length;
  const plural = rows.length === 1 ? 'subagent' : 'subagents';
  const headerMeta = allDone
    ? `All ${String(rows.length)} ${plural} finished`
    : inFlight && counts.running === 0
      ? `Spawning ${String(counts.pending)} ${counts.pending === 1 ? 'subagent' : 'subagents'}`
      : `${String(counts.completed)} of ${String(rows.length)} ${plural} finished`;

  const bodyTransition = reduceMotion
    ? { duration: 0.15 }
    : { type: 'spring' as const, stiffness: 320, damping: 27, mass: 0.9 };

  const header = (
    <button
      type="button"
      onClick={() => {
        setExpanded((value) => !value);
      }}
      aria-expanded={expanded}
      aria-controls={bodyId}
      className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
    >
      <span className="text-[12.5px] font-medium text-droid-text-secondary">Subagents</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[11.5px] text-droid-text-muted">{headerMeta}</span>
        {/* The total stays in the header so it survives expanding the card. */}
        {timeMs != null && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-droid-text-secondary">
            {formatDuration(timeMs)}
          </span>
        )}
      </span>
    </button>
  );

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape') setExpanded(false);
      }}
      className="w-full overflow-hidden rounded-[20px] border border-droid-border bg-droid-surface shadow-[0_10px_30px_rgba(0,0,0,0.30)] transition-colors hover:border-droid-border-hover"
    >
      {header}
      {/* Outside the expand animation, so expanding adds detail rather than
          swapping the summary away. */}
      <div className="flex items-center gap-2 px-4 pb-3 pt-0.5">
        {STATUS_ORDER.map(
          (status) =>
            counts[status] > 0 && (
              <StatusPill
                key={status}
                status={status}
                count={counts[status]}
                className="px-2.5 py-1 text-[11.5px]"
              />
            ),
        )}
        {/* One segment per subagent rather than a single fill: at 0% a lone empty
            track reads as nothing happening, while the segments show which agents
            are already working. */}
        <span className="ml-1 flex min-w-0 flex-1 items-center gap-1">
          {rows.map((row) => (
            <span
              key={rowKey(row)}
              className={`h-1.5 min-w-[3px] flex-1 rounded-full transition-colors duration-500 ${SEGMENT_TINT[row.status]}`}
            />
          ))}
        </span>
        <span className="shrink-0 text-[12.5px] font-semibold tabular-nums text-droid-text">
          {Math.round(progress * 100)}%
        </span>
      </div>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="rows"
            id={bodyId}
            initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={bodyTransition}
            className="overflow-hidden"
          >
            <motion.ul
              initial={reduceMotion ? false : 'hidden'}
              animate="show"
              variants={{ show: { transition: { staggerChildren: 0.045 } } }}
              className="px-2 pb-1.5"
            >
              {rows.map((row, i) => {
                const name = childSessionLabel(row.child, i);
                const model = models.find((m) => m.id === row.child.modelId);
                // Placeholder rows carry no model yet, so there is nothing honest
                // to reveal on hover until the child session registers.
                const modelLine = model?.displayName ?? row.child.modelId;
                // Rows without a live activity line (autonomous subagents report
                // no per-event transcript) still show what they were asked to do.
                const settledRow = row.status === 'completed' || !live;
                // Preference order, most specific first: the child's own
                // transcript, then whatever a poll of its background task
                // reported, then what it was asked to do.
                const polled = row.child.activity;
                const latest =
                  row.latest ??
                  (polled?.phase || polled?.preview
                    ? {
                        head: polled.phase ?? (row.status === 'completed' ? 'Done' : 'Working'),
                        body: polled.preview,
                      }
                    : {
                        head:
                          row.status === 'pending'
                            ? live
                              ? 'Spawning…'
                              : 'Never started'
                            : row.status === 'completed'
                              ? 'No activity captured'
                              : settledRow
                                ? 'Left running'
                                : 'Working',
                        body:
                          row.status === 'completed' ? undefined : previewLine(row.child.prompt),
                      });
                return (
                  <motion.li
                    key={rowKey(row)}
                    variants={
                      reduceMotion
                        ? undefined
                        : { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }
                    }
                  >
                    <button
                      type="button"
                      // Placeholder rows have no registered session to open yet.
                      disabled={!row.target || !onOpen || isPendingChildPlaceholder(row.child)}
                      onClick={() => row.target && onOpen?.(row.target)}
                      title={`Open ${name} session`}
                      className="group/row flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-droid-active/40 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span className="flex w-48 shrink-0 items-center gap-2.5">
                        <ModelIcon provider={providerOf(model, row.child.modelId)} size={16} />
                        {/* The name slot is too narrow for both the agent name and
                            its model, so hovering the row rolls one out and the
                            other in. Without a known model there is nothing to
                            reveal and the name simply stays put. */}
                        {modelLine ? (
                          <span className="relative block h-[18px] min-w-0 flex-1 overflow-hidden">
                            <span
                              className={`block truncate text-[13px] font-medium leading-[18px] text-droid-text ${
                                reduceMotion
                                  ? 'group-hover/row:hidden'
                                  : 'transition-transform duration-200 ease-out group-hover/row:-translate-y-[18px]'
                              }`}
                            >
                              {name}
                            </span>
                            <span
                              className={`block truncate text-[12px] leading-[18px] text-droid-text-secondary ${
                                reduceMotion
                                  ? 'hidden group-hover/row:block'
                                  : 'transition-transform duration-200 ease-out group-hover/row:-translate-y-[18px]'
                              }`}
                            >
                              {modelLine}
                            </span>
                          </span>
                        ) : (
                          <span className="truncate text-[13px] font-medium text-droid-text">
                            {name}
                          </span>
                        )}
                        {row.child.reasoningEffort && (
                          <span className="shrink-0 rounded-md bg-droid-accent/15 px-1.5 py-0.5 text-[10px] font-medium capitalize text-droid-accent">
                            {row.child.reasoningEffort}
                          </span>
                        )}
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate text-[12.5px] ${
                          settledRow ? 'text-droid-text-secondary' : 'text-droid-text'
                        }`}
                      >
                        {latest.head}
                        {latest.body && (
                          <span className="ml-1.5 text-[11.5px] text-droid-text-muted">
                            {latest.body}
                          </span>
                        )}
                      </span>
                      <StatusPill status={row.status} />
                      <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-droid-text-muted">
                        {durationMs[i] != null ? formatDuration(durationMs[i]) : ''}
                      </span>
                    </button>
                  </motion.li>
                );
              })}
            </motion.ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
