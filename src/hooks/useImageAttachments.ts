import { useState } from 'react';
import { discardImage, isDesktop, saveImage } from '../lib/desktop';
import { blobToDataUrl, cropImage, processImage } from '../lib/imageFiles';
import type { CropRect, ImagePasteQuality } from '../lib/images';
import { toast } from '../lib/toast';

export interface AttachedImage {
  id: string;
  /** Absolute path in the temp attachments dir; this is what the prompt @-mentions. */
  path: string;
  /** Data URL of the saved (fidelity-processed) image, used for chips/viewer. */
  preview: string;
}

/**
 * Owns the composer's image attachments. Pasted/dropped blobs are encoded per
 * the fidelity tier, written to disk via the desktop bridge, and tracked so a
 * crop can re-encode and swap the saved file in place.
 */
export function useImageAttachments(quality: ImagePasteQuality) {
  const [images, setImages] = useState<AttachedImage[]>([]);

  const addBlob = async (blob: Blob) => {
    if (!isDesktop()) {
      toast.error('Image attachments need the desktop app');
      return;
    }
    try {
      const raw = await blobToDataUrl(blob);
      const processed = await processImage(raw, quality);
      const path = await saveImage(processed);
      setImages((prev) => [...prev, { id: crypto.randomUUID(), path, preview: processed }]);
    } catch {
      toast.error('Could not attach that image');
    }
  };

  const remove = (id: string) => {
    setImages((prev) => {
      const hit = prev.find((i) => i.id === id);
      if (hit) void discardImage(hit.path);
      return prev.filter((i) => i.id !== id);
    });
  };

  // Errors propagate so the viewer can keep the crop UI open and report them.
  const applyCrop = async (id: string, rect: CropRect) => {
    const target = images.find((i) => i.id === id);
    if (!target) return;
    const cropped = await cropImage(target.preview, rect, quality);
    const path = await saveImage(cropped);
    setImages((prev) => {
      // The chip may have been removed while the crop was saving; discard the
      // new file instead of orphaning it in the temp dir.
      if (!prev.some((i) => i.id === id)) {
        void discardImage(path);
        return prev;
      }
      return prev.map((i) => {
        if (i.id !== id) return i;
        void discardImage(i.path);
        return { ...i, path, preview: cropped };
      });
    });
  };

  // After a submit the saved files are referenced by the in-flight prompt, so
  // the chips clear but the temp files must stay until the OS reclaims them.
  const clear = () => {
    setImages([]);
  };

  return { images, addBlob, remove, applyCrop, clear };
}
