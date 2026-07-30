import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDesignStore } from '../../hooks/useDesignStore';
import { readDesignCanvas, writeDesignCanvas } from '../../lib/commands';
import { bridge } from '../../lib/bridge';
import type { ServerEvent } from '../../types/bridge';
import { useStudioCanvas } from './StudioCanvasContext';
import {
  CanvasSaveCoordinator,
  canvasIdForSession,
  serializeStudioCanvas,
  type HydratedStudioCanvas,
} from './studioCanvasPersistence';

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
  const serialized = useMemo(() => serializeStudioCanvas(studio), [studio]);
  const currentContentRef = useRef(serialized.content);
  currentContentRef.current = serialized.content;
  const dispatchRef = useRef(studioDispatch);
  dispatchRef.current = studioDispatch;
  const [hydrationNotices, setHydrationNotices] = useState<string[]>([]);
  const [isHydrating, setIsHydrating] = useState(true);
  const coordinatorRef = useRef<CanvasSaveCoordinator | null>(null);
  const restoreTimerRef = useRef<number | null>(null);
  const clearRestoreTimer = useCallback(() => {
    if (restoreTimerRef.current === null) return;
    window.clearTimeout(restoreTimerRef.current);
    restoreTimerRef.current = null;
  }, []);

  coordinatorRef.current ??= new CanvasSaveCoordinator(
    {
      read: readDesignCanvas,
      write: writeDesignCanvas,
    },
    (hydrated: HydratedStudioCanvas) => {
      clearRestoreTimer();
      setIsHydrating(false);
      setHydrationNotices(hydrated.notices);
      dispatchRef.current({ type: 'HYDRATE', state: hydrated.state });
    },
    setHydrationNotices,
  );

  useEffect(() => {
    const unsubscribe = bridge.subscribe((event: ServerEvent) => {
      if (
        event.type === 'design.canvas.state' ||
        event.type === 'design.canvas.saved' ||
        event.type === 'design.canvas.error'
      ) {
        coordinatorRef.current?.receive(event);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const status = coordinatorRef.current?.open(
      { cwd, projectKey, canvasId },
      currentContentRef.current,
    );
    if (status === undefined || status === 'ready') return;

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
    coordinatorRef.current?.update(serialized.content);
  }, [serialized.content]);

  useEffect(() => {
    return () => {
      clearRestoreTimer();
      coordinatorRef.current?.dispose();
    };
  }, [clearRestoreTimer]);

  useEffect(() => {
    const flush = () => {
      coordinatorRef.current?.flush();
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  return {
    notices: [...hydrationNotices, ...serialized.notices],
    isHydrating,
  };
}
