import { useState } from 'react';
import { GripVertical, ImagePlus, ListPlus, X } from 'lucide-react';
import type { QueuedPrompt } from '../../hooks/useStore';

export default function StudioPromptQueue({
  appSessionId,
  queue,
  onRemove,
  onReorder,
}: {
  appSessionId: string;
  queue: QueuedPrompt[];
  onRemove: (appSessionId: string, id: string) => void;
  onReorder: (appSessionId: string, from: number, to: number) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  if (queue.length === 0) return null;

  const finishDrop = (to: number) => {
    if (dragIndex !== null && dragIndex !== to) onReorder(appSessionId, dragIndex, to);
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="mb-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 px-1 text-[10px] font-medium tracking-wide text-droid-text-muted">
        <ListPlus className="h-3 w-3" />
        Queued · sends after the current turn
      </div>
      {queue.map((prompt, index) => {
        const referenceCount = prompt.studio?.browserRefs?.length ?? 0;
        return (
          <div
            key={prompt.id}
            draggable
            onDragStart={() => {
              setDragIndex(index);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOverIndex(index);
            }}
            onDrop={() => {
              finishDrop(index);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setDragOverIndex(null);
            }}
            className={`group flex items-start gap-2 rounded-xl border bg-droid-elevated px-2 py-1.5 transition-colors ${
              dragOverIndex === index && dragIndex !== null && dragIndex !== index
                ? 'border-droid-accent'
                : 'border-droid-border'
            }`}
          >
            <span
              className="mt-0.5 cursor-grab text-droid-text-muted/60 active:cursor-grabbing"
              title="Drag to reorder"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block whitespace-pre-wrap break-words text-[12px] text-droid-text-secondary">
                {prompt.text || '(empty)'}
              </span>
              {referenceCount > 0 && (
                <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-black/20 px-1.5 py-0.5 text-[10px] text-droid-text-muted">
                  <ImagePlus className="h-3 w-3" />
                  {referenceCount} reference{referenceCount === 1 ? '' : 's'}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => {
                onRemove(appSessionId, prompt.id);
              }}
              className="shrink-0 rounded p-1 text-droid-text-muted transition-colors hover:bg-black/20 hover:text-droid-orange"
              title="Delete queued prompt"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
