import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesignStore } from '../../hooks/useDesignStore';
import { readDesignCanvas } from '../../lib/commands';
import { useStudioCanvas } from './StudioCanvasContext';
import { canvasIdForSession, serializeStudioCanvas } from './studioCanvasPersistence';
import { studioCanvasPersistenceOwner } from './studioCanvasPersistenceOwner';

const CANVAS_RESTORE_TIMEOUT_MS = 5_000;
const RESTORE_TIMEOUT_NOTICE =
  'Canvas restore took longer than expected. You can keep working while DROIDEX retries in the background.';

export function useStudioCanvasPersistence(
  cwd: string,
  projectKey: string,
): {
  notices: string[];
  isHydrating: boolean;
} {
  const { design } = useDesignStore();
  const { studio, studioDispatch } = useStudioCanvas();
  const rawSession = design.sessions[projectKey] ?? design.sessions[cwd];
  const canvasId = canvasIdForSession(rawSession);
  const currentStudioRef = useRef(studio);
  currentStudioRef.current = studio;
  const dispatchRef = useRef(studioDispatch);
  dispatchRef.current = studioDispatch;
  const [hydrationNotices, setHydrationNotices] = useState<string[]>([]);
  const [serializationNotices, setSerializationNotices] = useState<string[]>([]);
  const [isHydrating, setIsHydrating] = useState(true);
  const skipNextUpdateRef = useRef(false);
  const restoreTimerRef = useRef<number | null>(null);
  const clearRestoreTimer = useCallback(() => {
    if (restoreTimerRef.current === null) return;
    window.clearTimeout(restoreTimerRef.current);
    restoreTimerRef.current = null;
  }, []);

  useEffect(() => {
    return studioCanvasPersistenceOwner.attach({
      onHydrate: (hydrated) => {
        clearRestoreTimer();
        setIsHydrating(false);
        setHydrationNotices(hydrated.notices);
        dispatchRef.current({ type: 'HYDRATE', state: hydrated.state });
      },
      onNotice: setHydrationNotices,
      onSerialize: setSerializationNotices,
    });
  }, [clearRestoreTimer]);

  useEffect(() => {
    const status = studioCanvasPersistenceOwner.open(
      { cwd, projectKey, canvasId },
      serializeStudioCanvas(currentStudioRef.current).content,
    );
    skipNextUpdateRef.current = status !== 'started';

    setIsHydrating(true);
    clearRestoreTimer();
    restoreTimerRef.current = window.setTimeout(() => {
      restoreTimerRef.current = null;
      setIsHydrating(false);
      setHydrationNotices((current) =>
        current.includes(RESTORE_TIMEOUT_NOTICE) ? current : [RESTORE_TIMEOUT_NOTICE, ...current],
      );
      readDesignCanvas(cwd, canvasId);
    }, CANVAS_RESTORE_TIMEOUT_MS);

    return clearRestoreTimer;
  }, [canvasId, clearRestoreTimer, cwd, projectKey]);

  useEffect(() => {
    if (skipNextUpdateRef.current) {
      skipNextUpdateRef.current = false;
      return;
    }
    studioCanvasPersistenceOwner.update(studio);
  }, [studio]);

  useEffect(() => {
    const flush = () => {
      studioCanvasPersistenceOwner.flush();
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  return {
    notices: [...hydrationNotices, ...serializationNotices],
    isHydrating,
  };
}
