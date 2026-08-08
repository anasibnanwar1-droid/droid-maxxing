// Subagents section of the right context panel: one row per spawned child
// session with a pixel-creature identity, a quiet status readout, and a
// "Show N more" fold so long waves don't flood the panel.
import { useState } from 'react';
import { Check } from 'lucide-react';
import type { ChildSessionInfo } from '../hooks/useStore';
import type { ChildStatus, ModelInfo } from '../types/bridge';
import { childSessionLabel, childSessionMeta, orderedChildSessions } from '../lib/childSessions';
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
  index,
  models,
  selected,
  onSelect,
}: {
  child: ChildSessionInfo;
  index: number;
  models: ModelInfo[];
  selected: boolean;
  onSelect: (child: ChildSessionInfo) => void;
}) {
  const label = childSessionLabel(child, index);
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
        onClick={() => {
          onSelect(child);
        }}
        title={child.prompt ? `${meta}\n${child.prompt}` : meta}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left"
      >
        <span className="shrink-0 transition-[filter] group-hover:brightness-125">
          <AgentAvatar seed={child.childSessionId} size={16} working={child.status === 'running'} />
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
  const ordered = orderedChildSessions(childSessions);
  const visible = showAll ? ordered : ordered.slice(0, VISIBLE_LIMIT);

  return (
    <div>
      <SectionHeader label="Subagents" />
      <div>
        {visible.map((child, index) => (
          <SubagentRow
            key={child.childSessionId}
            child={child}
            index={index}
            models={models}
            selected={child.childSessionId === selectedChildSessionId}
            onSelect={onSelect}
          />
        ))}
      </div>
      {ordered.length > VISIBLE_LIMIT && (
        <button
          type="button"
          onClick={() => {
            setShowAll((value) => !value);
          }}
          className="w-full px-3 py-1.5 text-left text-[12px] text-droid-text-muted transition-colors hover:text-droid-text-secondary"
        >
          {showAll ? 'Show less' : `Show ${String(ordered.length - VISIBLE_LIMIT)} more`}
        </button>
      )}
    </div>
  );
}
