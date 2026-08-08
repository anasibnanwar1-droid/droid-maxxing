// Subagents section of the right context panel: one row per spawned child
// session with a pixel-creature identity, a quiet status readout, and a
// "Show N more" fold so long waves don't flood the panel. Working agents are
// ordered first, so the fold only ever hides agents that have stopped.
import { useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check } from 'lucide-react';
import type { ChildSessionInfo } from '../hooks/useStore';
import type { ChildStatus, ModelInfo } from '../types/bridge';
import {
  childSessionMeta,
  isPendingChildPlaceholder,
  workingFirstChildSessions,
} from '../lib/childSessions';
import { AgentAvatar } from './AgentAvatar';
import { SectionHeader } from './environment/primitives';

// Rows shown before the fold.
const VISIBLE_LIMIT = 5;

// Same status vocabulary as the in-chat subagents dock.
const STATUS_LABEL: Record<ChildStatus, string> = {
  running: 'Working',
  pending: 'Queued',
  paused: 'Idle',
  completed: 'Done',
};

function RowStatus({ status }: { status: ChildStatus }) {
  // The shimmer sweep is the working signal — no spinner, no pulsing dot.
  if (status === 'running') {
    return <span className="shimmer-text text-[11px] font-medium">Working</span>;
  }
  return (
    <span className="flex items-center gap-1 text-[11px] text-droid-text-muted">
      {status === 'completed' && <Check className="h-3 w-3" strokeWidth={3} />}
      {STATUS_LABEL[status]}
    </span>
  );
}

function SubagentRow({
  child,
  label,
  seed,
  models,
  selected,
  onSelect,
}: {
  child: ChildSessionInfo;
  label: string;
  seed: string;
  models: ModelInfo[];
  selected: boolean;
  onSelect: (child: ChildSessionInfo) => void;
}) {
  const model = models.find((m) => m.id === child.modelId);
  const meta = childSessionMeta(child, model?.displayName ?? child.modelId);
  return (
    <div
      data-testid="subagent-row"
      data-child-session-id={child.childSessionId}
      className={`group flex items-center rounded-lg transition-colors ${
        selected ? 'bg-droid-elevated/70' : 'hover:bg-droid-elevated/40'
      }`}
    >
      <button
        type="button"
        // A spawn the store has not registered yet has no session to open.
        disabled={isPendingChildPlaceholder(child)}
        onClick={() => {
          onSelect(child);
        }}
        title={child.prompt ? `${meta}\n${child.prompt}` : meta}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left disabled:cursor-default"
      >
        <span className="shrink-0 transition-[filter] group-hover:brightness-125">
          <AgentAvatar seed={seed} size={16} working={child.status === 'running'} />
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-[12.5px] font-medium ${
            selected ? 'text-droid-text' : 'text-droid-text-secondary group-hover:text-droid-text'
          }`}
        >
          {label}
        </span>
        <RowStatus status={child.status} />
      </button>
    </div>
  );
}

export function SubagentsSection({
  childSessions,
  models,
  selectedChildSessionId,
  onSelect,
}: {
  childSessions: ChildSessionInfo[];
  models: ModelInfo[];
  selectedChildSessionId: string | null;
  onSelect: (child: ChildSessionInfo) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const reduceMotion = useReducedMotion();
  const ordered = workingFirstChildSessions(childSessions);
  const visible = useMemo(() => {
    if (showAll) return ordered;
    const head = ordered.slice(0, VISIBLE_LIMIT);
    // The agent whose transcript the app is currently showing must stay on
    // screen; hiding its row behind the fold leaves the selection unexplained.
    const selected = ordered.findIndex(
      ({ child }) => child.childSessionId === selectedChildSessionId,
    );
    return selected < VISIBLE_LIMIT ? head : [...head, ordered[selected]];
  }, [ordered, showAll, selectedChildSessionId]);
  const hidden = ordered.length - visible.length;

  return (
    <div>
      <SectionHeader label="Subagents" />
      <div>
        {/* Rows animate in as agents spawn and slide when one finishes and drops
            below the still-working ones; `layout` does the reordering so nothing
            jumps. */}
        <AnimatePresence initial={false}>
          {visible.map(({ child, name, key }) => (
            <motion.div
              key={key}
              layout={reduceMotion ? false : 'position'}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
              animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
              // Leaving rows only fade: a row usually leaves because it dropped
              // behind the fold, and sliding it anywhere would suggest it moved.
              exit={{ opacity: 0 }}
              transition={
                reduceMotion ? { duration: 0.12 } : { type: 'spring', stiffness: 420, damping: 34 }
              }
            >
              <SubagentRow
                child={child}
                label={name}
                seed={key}
                models={models}
                selected={child.childSessionId === selectedChildSessionId}
                onSelect={onSelect}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {(hidden > 0 || (showAll && ordered.length > VISIBLE_LIMIT)) && (
        <button
          type="button"
          onClick={() => {
            setShowAll((value) => !value);
          }}
          className="w-full px-3 py-1.5 text-left text-[12px] text-droid-text-muted transition-colors hover:text-droid-text-secondary"
        >
          {showAll ? 'Show less' : `Show ${String(hidden)} more`}
        </button>
      )}
    </div>
  );
}
