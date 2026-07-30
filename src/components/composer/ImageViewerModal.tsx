import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import { Check, Crop, X } from 'lucide-react';
import type { AttachedImage } from '../../hooks/useImageAttachments';
import { displayedToNaturalRect, isFullImageRect, type CropRect } from '../../lib/images';
import { toast } from '../../lib/toast';
import { CropOverlay } from './CropOverlay';

// Same focusable-element query the environment Popover uses for its Tab trap.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const dialogRef = useRef<HTMLDivElement>(null);

  // Modal focus boundary: without it, keyboard and AT users keep reaching the
  // composer controls behind this full-screen overlay. Move focus inside on
  // open and hand it back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    if (dialog) {
      const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length > 0) focusables[0].focus();
      else dialog.focus();
    }
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  // Keep Tab/Shift+Tab cycling inside the dialog while it is open. Focus on
  // the container itself (clicked non-focusable backdrop content focuses the
  // nearest tabindex ancestor) wraps to the edges instead of escaping.
  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const onDialog = active === dialog;
    if (e.shiftKey && (active === first || onDialog || !dialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || onDialog || !dialog.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

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
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      tabIndex={-1}
      onKeyDown={trapTab}
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
