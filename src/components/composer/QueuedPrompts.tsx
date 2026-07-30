import { useState } from 'react';
import { GripVertical, ListPlus, MousePointerSquareDashed, Pencil, X } from 'lucide-react';
import type { QueuedPrompt } from '../../hooks/useStore';

// Prompts staged while the model is busy; they send one at a time after the
// current turn. Rows are HTML5-draggable to reorder; the drag state lives here
// because nothing outside the list cares about an in-flight reorder.
export function QueuedPrompts({
  queue,
  onReorder,
  onEdit,
  onRemove,
}: {
  queue: QueuedPrompt[];
  onReorder: (from: number, to: number) => void;
  onEdit: (prompt: QueuedPrompt) => void;
  onRemove: (id: string) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  if (queue.length === 0) return null;

  const handleDrop = (to: number) => {
    if (dragIndex !== null && dragIndex !== to) onReorder(dragIndex, to);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 px-1 text-[10px] font-medium tracking-wide text-droid-text-muted">
        <ListPlus className="w-3 h-3" />
        Queued · sends after the current turn
      </div>
      {queue.map((p, i) => (
        <div
          key={p.id}
          draggable
          onDragStart={() => {
            setDragIndex(i);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverIndex(i);
          }}
          onDrop={() => {
            handleDrop(i);
          }}
          onDragEnd={() => {
            setDragIndex(null);
            setDragOverIndex(null);
          }}
          className={`group flex items-start gap-2 rounded-xl border bg-droid-elevated px-2 py-1.5 transition-colors ${
            dragOverIndex === i && dragIndex !== null && dragIndex !== i
              ? 'border-droid-orange'
              : 'border-droid-border'
          }`}
        >
          <span
            className="mt-0.5 cursor-grab text-droid-text-muted/60 active:cursor-grabbing"
            title="Drag to reorder"
          >
            <GripVertical className="w-3.5 h-3.5" />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block whitespace-pre-wrap break-words text-[12px] text-droid-text-secondary">
              {p.text || '(empty)'}
            </span>
            {p.design && p.design.references.length > 0 && (
              <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-black/20 px-1.5 py-0.5 text-[10px] text-droid-text-muted">
                <MousePointerSquareDashed className="w-3 h-3" />
                {p.design.references.length} reference
                {p.design.references.length === 1 ? '' : 's'}
              </span>
            )}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            {!p.design && (
              <button
                onClick={() => {
                  onEdit(p);
                }}
                className="rounded p-1 text-droid-text-muted hover:text-droid-text hover:bg-black/20"
                title="Edit in composer"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => {
                onRemove(p.id);
              }}
              className="rounded p-1 text-droid-text-muted hover:text-droid-orange hover:bg-black/20"
              title="Delete"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
