import { useEffect, useRef } from 'react';
import { useDesignStore } from '../../hooks/useDesignStore';
import type { CanvasFrameSource } from '../../types/bridge';
import { useStudioCanvas, type StudioCanvasAction } from './StudioCanvasContext';

interface PreviewFrame {
  id: string;
  name: string;
  url: string;
  kind?: 'page' | 'component';
  source: CanvasFrameSource;
}

/**
 * Bridges `design.preview` events (useDesignStore) onto the canvas
 * (StudioCanvasContext): a new preview becomes a tall "showcase" frame; a
 * regenerated one reloads in place (stable frame id + cache-buster).
 */
export function usePreviewFrames(cwd: string, enabled = true) {
  const { design } = useDesignStore();
  const { studio, studioDispatch } = useStudioCanvas();
  const bump = useRef(0);
  const hasHandledPreview = useRef(false);
  const framesRef = useRef(studio.frames);
  framesRef.current = studio.frames;
  // Record lookup can miss at runtime even though the index type says otherwise.
  const preview = design.previews[cwd] as PreviewFrame | undefined;

  useEffect(() => {
    bump.current = 0;
    hasHandledPreview.current = false;
  }, [cwd]);

  useEffect(() => {
    if (!enabled) {
      hasHandledPreview.current = false;
      return;
    }
    if (!preview) return;
    const exists = framesRef.current.some((f) => f.id === preview.id);
    if (exists) bump.current += 1;
    const shouldFocus = !exists || hasHandledPreview.current;
    hasHandledPreview.current = true;
    for (const action of previewFrameActions(preview, exists, bump.current, shouldFocus)) {
      studioDispatch(action);
    }
  }, [cwd, preview, enabled, studioDispatch]);
}

export function previewFrameActions(
  preview: PreviewFrame,
  exists: boolean,
  revision: number,
  shouldFocus = true,
): StudioCanvasAction[] {
  const sync: StudioCanvasAction = exists
    ? {
        type: 'UPDATE_FRAME',
        id: preview.id,
        patch: {
          url: `${preview.url}?v=${String(revision)}`,
          source: preview.source,
          status: 'loading',
        },
      }
    : {
        type: 'ADD_FRAME',
        frame: {
          id: preview.id,
          name: preview.name,
          url: preview.url,
          source: preview.source,
          mode: 'custom',
          width: preview.kind === 'component' ? 720 : 1200,
          height: preview.kind === 'component' ? 480 : 3200,
          kind: 'showcase',
        },
      };
  return shouldFocus ? [sync, { type: 'REQUEST_FRAME_FOCUS', id: preview.id }] : [sync];
}
