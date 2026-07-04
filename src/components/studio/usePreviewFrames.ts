import { useEffect, useRef } from 'react';
import { useDesignStore } from '../../hooks/useDesignStore';
import { useStudioCanvas } from './StudioCanvasContext';

/**
 * Bridges `design.preview` events (useDesignStore) onto the canvas
 * (StudioCanvasContext): a new preview becomes a tall "showcase" frame; a
 * regenerated one reloads in place (stable frame id + cache-buster).
 */
export function usePreviewFrames(cwd: string) {
  const { design } = useDesignStore();
  const { studio, studioDispatch } = useStudioCanvas();
  const bump = useRef(0);
  const framesRef = useRef(studio.frames);
  framesRef.current = studio.frames;
  const preview = design.previews[cwd];

  useEffect(() => {
    if (!preview) return;
    const exists = framesRef.current.some((f) => f.id === preview.id);
    if (exists) {
      bump.current += 1;
      studioDispatch({
        type: 'UPDATE_FRAME',
        id: preview.id,
        patch: { url: `${preview.url}?v=${bump.current}`, status: 'loading' },
      });
    } else {
      studioDispatch({
        type: 'ADD_FRAME',
        frame: {
          id: preview.id,
          name: preview.name,
          url: preview.url,
          mode: 'custom',
          width: 1200,
          height: 3200,
          kind: 'showcase',
        },
      });
    }
  }, [preview, studioDispatch]);
}
