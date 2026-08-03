import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { importDesignLibraryImage } from '../../lib/commands';
import { toast } from '../../lib/toast';
import { useStudioCanvas, type StudioCanvasImage } from './StudioCanvasContext';
import { screenToWorld, type Point } from './studioCanvasMath';
import { fittedCanvasImageSize } from './studioCanvasImages';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function useCanvasImageImport(rootRef: RefObject<HTMLDivElement | null>, cwd: string) {
  const { studio, studioDispatch } = useStudioCanvas();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPointerRef = useRef<Point | null>(null);
  const imageCountRef = useRef(studio.images.length);
  imageCountRef.current = studio.images.length;
  const viewRef = useRef(studio.view);
  viewRef.current = studio.view;

  const trackPointer = (clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    lastPointerRef.current = { x: clientX - rect.left, y: clientY - rect.top };
  };

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const accepted = acceptedCanvasFiles(files, imageCountRef.current);
      if (accepted.length === 0) return;

      let placed = 0;
      for (const file of accepted) {
        try {
          const dataUrl = await readDataUrl(file);
          const natural = await readImageSize(dataUrl);
          const size = fittedCanvasImageSize(natural.width, natural.height);
          const root = rootRef.current?.getBoundingClientRect();
          const screenAnchor = lastPointerRef.current ?? {
            x: (root?.width ?? 800) / 2,
            y: (root?.height ?? 600) / 2,
          };
          const worldAnchor = screenToWorld(screenAnchor, viewRef.current);
          const id = canvasImageId();
          const name = imageName(file.name, imageCountRef.current + placed + 1);
          const offset = placed * 28;
          const image: StudioCanvasImage = {
            id,
            libraryId: id,
            src: dataUrl,
            name,
            tag: 'inspiration',
            x: worldAnchor.x - size.width / 2 + offset,
            y: worldAnchor.y - size.height / 2 + offset,
            width: size.width,
            height: size.height,
            naturalWidth: natural.width,
            naturalHeight: natural.height,
          };
          studioDispatch({ type: 'ADD_CANVAS_IMAGE', image });
          importDesignLibraryImage({
            cwd,
            id,
            name,
            category: image.tag,
            dataUrl,
          });
          placed += 1;
        } catch (error) {
          console.error('[Studio] Canvas image import failed:', error);
          toast.error('That image could not be added to the canvas.');
        }
      }
      if (placed > 0) {
        toast.success(`${String(placed)} image${placed === 1 ? '' : 's'} added to the canvas.`);
      }
    },
    [cwd, rootRef, studioDispatch],
  );

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (images.length === 0) return;
      event.preventDefault();
      void addFiles(images);
    };
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('paste', onPaste);
    };
  }, [addFiles]);

  return {
    fileInputRef,
    addFiles,
    trackPointer,
    requestFilePicker: () => {
      fileInputRef.current?.click();
    },
  };
}

function acceptedCanvasFiles(files: FileList | File[], currentCount: number): File[] {
  const candidates = Array.from(files).filter((file) => SUPPORTED_TYPES.has(file.type));
  if (candidates.length === 0) {
    toast.error('Paste or choose a PNG, JPEG, WebP, or GIF image.');
    return [];
  }
  const available = Math.max(0, 24 - currentCount);
  if (available === 0) {
    toast.error('This canvas already has the maximum of 24 images.');
    return [];
  }
  const accepted = candidates.slice(0, available);
  const valid = accepted.filter((file) => file.size > 0 && file.size <= MAX_IMAGE_BYTES);
  if (valid.length !== accepted.length) {
    toast.error('Canvas images must be between 1 byte and 20 MB.');
  }
  return valid;
}

function canvasImageId(): string {
  try {
    return `canvas-${crypto.randomUUID().toLowerCase()}`;
  } catch {
    return `canvas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function imageName(fileName: string, index: number): string {
  const clean = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!clean || /^image(?:\s+\d+)?$/i.test(clean)) return `Inspiration ${String(index)}`;
  return clean.slice(0, 120);
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error('Image could not be read.'));
    };
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Image did not produce a data URL.'));
    };
    reader.readAsDataURL(file);
  });
}

function readImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => {
      reject(new Error('Image dimensions could not be read.'));
    };
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.src = src;
  });
}
