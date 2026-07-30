import { useEffect, useRef } from 'react';
import { useDesignStore } from '../../hooks/useDesignStore';
import type { CanvasFrameSource } from '../../types/bridge';
import { useStudioCanvas } from './StudioCanvasContext';

/**
 * Bridges `design.preview` events (useDesignStore) onto the canvas
 * (StudioCanvasContext): a new preview becomes a tall "showcase" frame; a
 * regenerated one reloads in place (stable frame id + cache-buster).
 */
export function usePreviewFrames(cwd: string, enabled = true) {
  const { design } = useDesignStore();
  const { studio, studioDispatch } = useStudioCanvas();
  const bump = useRef(0);
  const framesRef = useRef(studio.frames);
  framesRef.current = studio.frames;
  // Record lookup can miss at runtime even though the index type says otherwise.
  const preview = design.previews[cwd] as
    | {
        id: string;
        name: string;
        url: string;
        kind?: 'page' | 'component';
        source: CanvasFrameSource;
      }
    | undefined;

  useEffect(() => {
    if (!preview || !enabled) return;
    const exists = framesRef.current.some((f) => f.id === preview.id);
    if (exists) {
      bump.current += 1;
      studioDispatch({
        type: 'UPDATE_FRAME',
        id: preview.id,
        patch: {
          url: `${preview.url}?v=${String(bump.current)}`,
          source: preview.source,
          status: 'loading',
        },
      });
    } else {
      // Component stages are small and centered; pages get the tall showcase.
      const component = preview.kind === 'component';
      studioDispatch({
        type: 'ADD_FRAME',
        frame: {
          id: preview.id,
          name: preview.name,
          url: preview.url,
          source: preview.source,
          mode: 'custom',
          width: component ? 720 : 1200,
          height: component ? 480 : 3200,
          kind: 'showcase',
        },
      });
    }
  }, [preview, enabled, studioDispatch]);
}
