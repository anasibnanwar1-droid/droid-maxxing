import { useCallback, useRef, useState } from 'react';
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
 * Bookkeeping for in-flight additions, kept out of React state so async
 * continuations can consult it after any number of awaits. `settled` lets the
 * submit path wait for a quiescent attachment list; the generation stamp lets
 * clear() invalidate adds that are still encoding, so their late landing
 * discards the saved file instead of reviving a chip on the next prompt.
 */
export function createPendingAdditions() {
  let generation = 0;
  const pending = new Set<Promise<unknown>>();
  return {
    /** Stamps an addition when it starts; compare with isStale when it lands. */
    stamp: () => generation,
    isStale: (stamped: number) => stamped !== generation,
    invalidate: () => {
      generation += 1;
    },
    track: (task: Promise<unknown>) => {
      pending.add(task);
      const done = () => {
        pending.delete(task);
      };
      // then(onFulfilled, onRejected) so a failed encode can't reject the chain.
      void task.then(done, done);
    },
    /** Resolves once every tracked add — including ones started while awaiting — has finished. */
    settled: async (): Promise<void> => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

export type PendingAdditions = ReturnType<typeof createPendingAdditions>;

/**
 * Writes a fresh image file, then applies the clear() race guard shared by
 * adds and crops: if the composer was cleared while the file was being
 * written, the file would surface out of nowhere on a later prompt, so it is
 * deleted and the save is reported as void (null). The discard runs after the
 * save resolves because the file does not exist to delete before then.
 */
export async function saveImageUnlessStale(
  additions: PendingAdditions,
  stamp: number,
  save: () => Promise<string>,
  discard: (path: string) => Promise<void>,
): Promise<string | null> {
  const path = await save();
  if (!additions.isStale(stamp)) return path;
  void discard(path);
  return null;
}

/**
 * Appends an image in paste/drop order. Each add reserves a sequence number
 * before its variably slow encode, so completion order must not reorder chips
 * or the prompt's attachment list. Ids without a reserved sequence sort last.
 */
export function insertBySequence(
  images: AttachedImage[],
  image: AttachedImage,
  sequences: ReadonlyMap<string, number>,
): AttachedImage[] {
  const order = (item: AttachedImage) => sequences.get(item.id) ?? Number.MAX_SAFE_INTEGER;
  return [...images, image].sort((a, b) => order(a) - order(b));
}

/**
 * Owns the composer's image attachments. Pasted/dropped blobs are encoded per
 * the fidelity tier, written to disk via the desktop bridge, and tracked so a
 * crop can re-encode and swap the saved file in place.
 *
 * `imagesRef` mirrors the list so async continuations read the live list after
 * awaits instead of a stale render closure; every write goes through `commit`.
 * File deletion never happens inside a `setImages` updater: StrictMode double-
 * invokes updaters, which would fire discardImage twice per removal.
 */
export function useImageAttachments(quality: ImagePasteQuality) {
  const [images, setImages] = useState<AttachedImage[]>([]);
  const imagesRef = useRef(images);
  const sequencesRef = useRef(new Map<string, number>());
  const nextSeqRef = useRef(0);
  // Stable per-mount instance; not React state in the render sense.
  const [additions] = useState(() => createPendingAdditions());

  // useCallback: commit and clear are referenced from PromptInput effects, so
  // they must keep a stable identity across renders.
  const commit = useCallback((next: AttachedImage[]) => {
    imagesRef.current = next;
    setImages(next);
  }, []);

  const addBlob = (blob: Blob) => {
    if (!isDesktop()) {
      toast.error('Image attachments need the desktop app');
      return;
    }
    // Reserve the chip's position synchronously: a paste whose encode runs
    // long must not overtake one that was added later but finished earlier.
    const seq = nextSeqRef.current++;
    const stamp = additions.stamp();
    const task = (async () => {
      try {
        const raw = await blobToDataUrl(blob);
        const processed = await processImage(raw, quality);
        const path = await saveImageUnlessStale(
          additions,
          stamp,
          () => saveImage(processed),
          discardImage,
        );
        // clear() ran during the encode (submit): the fresh file was deleted
        // rather than reviving a chip on the next prompt.
        if (path === null) return;
        const image = { id: crypto.randomUUID(), path, preview: processed };
        sequencesRef.current.set(image.id, seq);
        commit(insertBySequence(imagesRef.current, image, sequencesRef.current));
      } catch {
        toast.error('Could not attach that image');
      }
    })();
    additions.track(task);
  };

  const remove = (id: string) => {
    const hit = imagesRef.current.find((i) => i.id === id);
    if (!hit) return;
    sequencesRef.current.delete(id);
    commit(imagesRef.current.filter((i) => i.id !== id));
    // Outside the state update so it fires exactly once per removal.
    void discardImage(hit.path);
  };

  // Errors propagate so the viewer can keep the crop UI open and report them.
  const applyCrop = async (id: string, rect: CropRect) => {
    const target = imagesRef.current.find((i) => i.id === id);
    if (!target) return;
    // Tracked like an add: whenSettled() must wait for an in-flight crop, or a
    // crop landing mid-submit could delete a path the prompt references.
    const stamp = additions.stamp();
    const task = (async () => {
      const cropped = await cropImage(target.preview, rect, quality);
      // A clear() (submit) during the crop means the old path is now
      // referenced by a prompt; the new file is discarded, state left alone.
      const path = await saveImageUnlessStale(
        additions,
        stamp,
        () => saveImage(cropped),
        discardImage,
      );
      if (path === null) return;
      // The chip may have been removed while the crop was saving; discard the
      // new file instead of orphaning it in the temp dir.
      const existing = imagesRef.current.find((i) => i.id === id);
      if (!existing) {
        void discardImage(path);
        return;
      }
      commit(imagesRef.current.map((i) => (i.id === id ? { ...i, path, preview: cropped } : i)));
      // After the commit: exactly one deletion of the superseded file.
      void discardImage(existing.path);
    })();
    additions.track(task);
    await task;
  };

  // After a submit the saved files are referenced by the in-flight prompt, so
  // the chips clear but the temp files must stay until the OS reclaims them.
  // Stable identity (see commit): PromptInput's session-switch effect lists it
  // as a dependency.
  const clear = useCallback(() => {
    additions.invalidate();
    sequencesRef.current.clear();
    commit([]);
  }, [additions, commit]);

  // Non-submit clears (session switch, editing a queued prompt): no prompt
  // references the committed files, so delete them instead of orphaning them
  // until the daily sweep. In-flight adds still self-discard via the stamp.
  const clearAndDiscard = useCallback(() => {
    for (const image of imagesRef.current) void discardImage(image.path);
    clear();
  }, [clear]);

  /**
   * Submit-path support: resolves with the live list once every in-flight add
   * has landed or failed, so a prompt never snapshots attachments mid-encode.
   */
  const whenSettled = async (): Promise<AttachedImage[]> => {
    await additions.settled();
    return imagesRef.current;
  };

  return { images, addBlob, remove, applyCrop, clear, clearAndDiscard, whenSettled };
}
