import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Crop, X } from 'lucide-react';
import type { AttachedImage } from '../../hooks/useImageAttachments';
import { displayedToNaturalRect, isFullImageRect, type CropRect } from '../../lib/images';
import { toast } from '../../lib/toast';
import { CropOverlay } from './CropOverlay';

/**
 * In-app viewer for an attached image: click a chip to inspect it full-size,
 * optionally drag a crop, or just close. Crop rects are drawn in displayed
 * pixels and handed to the parent as natural pixels via onCrop.
 */
export function ImageViewerModal({
  image,
  onCrop,
  onClose,
}: {
  image: AttachedImage;
  onCrop: (id: string, rect: CropRect) => Promise<void>;
  onClose: () => void;
}) {
  const [cropping, setCropping] = useState(false);
  const [rect, setRect] = useState<CropRect | null>(null);
  const [saving, setSaving] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (cropping) {
        setCropping(false);
        setRect(null);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [cropping, onClose]);

  const applyCrop = async () => {
    const img = imgRef.current;
    if (!rect || !img?.clientWidth || !img.clientHeight) return;
    // Sizes are read live at apply time so a window resize while the viewer is
    // open can't skew the displayed-to-natural mapping.
    const naturalRect = displayedToNaturalRect(
      rect,
      { width: img.clientWidth, height: img.clientHeight },
      { width: img.naturalWidth, height: img.naturalHeight },
    );
    setSaving(true);
    try {
      if (!isFullImageRect(naturalRect, { width: img.naturalWidth, height: img.naturalHeight }))
        await onCrop(image.id, naturalRect);
      setCropping(false);
      setRect(null);
    } catch {
      // Stay in crop mode so the selection isn't lost.
      toast.error('Could not save the crop');
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12 }}
      className="fixed inset-0 z-[1200] flex flex-col bg-black/70 backdrop-blur-sm"
      onClick={cropping ? undefined : onClose}
    >
      <div className="flex flex-1 items-center justify-center overflow-hidden p-8">
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          className="relative max-h-full"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <img
            ref={imgRef}
            src={image.preview}
            alt="Attached image preview"
            draggable={false}
            className="block max-h-[75vh] max-w-[88vw] select-none rounded-lg border border-droid-border object-contain"
          />
          {cropping && <CropOverlay rect={rect} onChange={setRect} />}
        </motion.div>
      </div>

      <div
        className="flex items-center gap-3 border-t border-droid-border/60 bg-droid-bg/80 px-5 py-3"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-droid-text-muted">
          {cropping ? 'Drag across the image to choose a crop' : image.path}
        </span>
        {cropping ? (
          <>
            <button
              onClick={() => {
                setCropping(false);
                setRect(null);
              }}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text"
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
            <button
              onClick={() => void applyCrop()}
              disabled={!rect || saving}
              className="flex items-center gap-1.5 rounded-lg bg-droid-accent px-3 py-1.5 text-[12px] font-medium text-droid-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={3} /> {saving ? 'Saving…' : 'Apply crop'}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => {
                setCropping(true);
              }}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text"
            >
              <Crop className="h-3.5 w-3.5" /> Crop
            </button>
            <button
              onClick={onClose}
              className="flex items-center gap-1.5 rounded-lg bg-droid-accent px-3 py-1.5 text-[12px] font-medium text-droid-bg transition-opacity hover:opacity-90"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={3} /> Done
            </button>
          </>
        )}
      </div>
    </motion.div>
  );
}
