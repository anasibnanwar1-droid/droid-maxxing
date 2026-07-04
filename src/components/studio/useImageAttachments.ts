import { useState, type ClipboardEvent } from 'react';

/**
 * Image attachments shared by the composer and the design interview: paste,
 * file-pick, remove, clear. Reads files as data URLs and caps the count so a
 * paste storm can't blow up state.
 */
export function useImageAttachments(max = 6) {
  const [images, setImages] = useState<string[]>([]);

  const addFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') return;
        setImages((prev) => (prev.length >= max ? prev : [...prev, reader.result as string]));
      };
      reader.readAsDataURL(file);
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (imgs.length > 0) {
      e.preventDefault();
      addFiles(imgs);
    }
  };

  const remove = (index: number) =>
    setImages((prev) => prev.filter((_, i) => i !== index));
  const clear = () => setImages([]);

  return { images, addFiles, onPaste, remove, clear };
}
