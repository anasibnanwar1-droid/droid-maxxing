import { Send, X } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { DesignReference } from '../../types/bridge';

interface DesignModeComposerProps {
  references: DesignReference[];
  instruction: string;
  disabledReason?: string;
  canSend: boolean;
  style: CSSProperties;
  onInstructionChange: (value: string) => void;
  onRemoveReference: (id: string) => void;
  onSend: () => void;
}

export function DesignModeComposer({
  references,
  instruction,
  disabledReason,
  canSend,
  style,
  onInstructionChange,
  onRemoveReference,
  onSend,
}: DesignModeComposerProps) {
  return (
    <div
      className="absolute z-30 w-[min(420px,calc(100%-24px))] rounded-xl border border-droid-border bg-droid-surface/95 shadow-[0_18px_50px_rgba(0,0,0,0.45)] backdrop-blur"
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 border-b border-droid-border px-2.5 py-2">
        {references.map((ref, index) => (
          <button
            key={ref.id ?? `${ref.kind}-${index}`}
            onClick={() => ref.id && onRemoveReference(ref.id)}
            className="group flex h-6 max-w-[180px] items-center gap-1.5 rounded-md bg-droid-elevated px-2 text-[11px] text-droid-text-secondary hover:text-droid-text"
            title="Remove reference"
          >
            <span className="font-mono text-droid-accent">ref</span>
            <span className="truncate">{labelFor(ref)}</span>
            <X className="h-3 w-3 shrink-0 text-droid-text-muted group-hover:text-droid-text" />
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <input
          autoFocus
          value={instruction}
          onChange={(event) => onInstructionChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && canSend) {
              event.preventDefault();
              onSend();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-droid-text placeholder:text-droid-text-muted focus:outline-none"
          placeholder="Describe the change"
        />
        <button
          onClick={onSend}
          disabled={!canSend}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-droid-text text-droid-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-35"
          title={canSend ? 'Send to Droid' : disabledReason || 'Select a reference'}
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function labelFor(ref: DesignReference): string {
  if (ref.kind === 'element') return ref.element?.name || ref.element?.text || ref.element?.tagName || 'element';
  if (ref.kind === 'region') return 'region';
  return 'stroke';
}
