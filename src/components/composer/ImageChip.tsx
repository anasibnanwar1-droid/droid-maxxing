import { X } from 'lucide-react';
import type { AttachedImage } from '../../hooks/useImageAttachments';

// Thumbnail chip for an attached image. Clicking the image opens the viewer;
// the corner badge removes it without opening anything.
export function ImageChip({
  image,
  onOpen,
  onRemove,
}: {
  image: AttachedImage;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <span className="group relative shrink-0">
      <button
        onClick={onOpen}
        className="block h-16 w-16 overflow-hidden rounded-lg border border-droid-border bg-droid-bg/60 transition-colors hover:border-droid-border-hover"
        title="View image"
      >
        <img
          src={image.preview}
          alt="Attached image"
          draggable={false}
          className="h-full w-full object-cover"
        />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-droid-border bg-droid-elevated text-droid-text-muted shadow-sm transition-colors hover:border-droid-border-hover hover:text-droid-text"
        title="Remove image"
      >
        <X className="h-2.5 w-2.5" strokeWidth={3} />
      </button>
    </span>
  );
}
