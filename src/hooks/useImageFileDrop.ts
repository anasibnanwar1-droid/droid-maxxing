import { useCallback } from 'react';

// Drop handlers for the composer wrapper. Chromium navigates the window to a
// dropped file, which would destroy the app state, so file drops are always
// swallowed; images are handed to the attachment store. Non-file drags (queue
// reorder) pass through untouched.
export function useImageFileDrop(addBlob: (blob: Blob) => Promise<void> | void) {
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      const dropped = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
      for (const file of dropped) void addBlob(file);
    },
    [addBlob],
  );

  return { onDragOver, onDrop };
}
