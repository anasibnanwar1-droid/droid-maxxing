import { Send, X } from 'lucide-react';
import type { DesignReference } from '../../types/bridge';

interface DesignPromptBarProps {
  references: DesignReference[];
  instruction: string;
  canSend: boolean;
  disabledReason?: string;
  onInstructionChange: (value: string) => void;
  onRemoveReference: (id: string) => void;
  onSend: () => void;
}

export function DesignPromptBar({
  references,
  instruction,
  canSend,
  disabledReason,
  onInstructionChange,
  onRemoveReference,
  onSend,
}: DesignPromptBarProps) {
  return (
    <div className="border-t border-droid-border bg-droid-bg/95 px-4 py-3">
      <div className="mx-auto flex max-w-5xl items-end gap-3">
        <div className="min-w-0 flex-1 rounded-lg border border-droid-border bg-droid-surface">
          {references.length > 0 && (
            <div className="flex min-h-9 flex-wrap items-center gap-1.5 border-b border-droid-border px-2.5 py-2">
              {references.map((ref, index) => (
                <button
                  key={ref.id}
                  onClick={() => ref.id && onRemoveReference(ref.id)}
                  className="group flex h-6 max-w-[180px] items-center gap-1 rounded-md bg-droid-elevated px-2 text-[11px] text-droid-text-secondary hover:text-droid-text"
                  title="Remove reference"
                >
                  <span className="font-mono text-droid-accent">{index + 1}</span>
                  <span className="truncate">{labelFor(ref)}</span>
                  <X className="h-3 w-3 shrink-0 text-droid-text-muted group-hover:text-droid-text" />
                </button>
              ))}
            </div>
          )}
          <textarea
            value={instruction}
            onChange={(event) => onInstructionChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSend) {
                event.preventDefault();
                onSend();
              }
            }}
            rows={2}
            className="block max-h-28 min-h-[58px] w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-5 text-droid-text placeholder:text-droid-text-muted focus:outline-none"
            placeholder="Describe the change..."
          />
        </div>
        <button
          onClick={onSend}
          disabled={!canSend}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-droid-text text-droid-bg transition-opacity disabled:cursor-not-allowed disabled:opacity-35"
          title={canSend ? 'Send to Droid' : disabledReason || 'Select a reference'}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function labelFor(ref: DesignReference): string {
  if (ref.kind === 'element') {
    return ref.element?.name || ref.element?.text || ref.element?.tagName || 'element';
  }
  if (ref.kind === 'region') return 'region';
  return 'stroke';
}
