import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../../hooks/useStore';
import { useDesignStore } from '../../hooks/useDesignStore';
import { StudioCanvasProvider } from '../studio/StudioCanvasContext';
import StudioShell from '../studio/StudioShell';
import StudioMark from '../studio/StudioMark';

/**
 * DROIDEX Studio — a full-screen, agent-native design surface: an infinite live
 * canvas of frames with a project agent chat. Opened via the Sidebar entry or
 * ⌘⇧D; closed with Escape. State lives in a self-contained canvas context.
 */
export default function DesignStudio() {
  const { state, dispatch } = useStore();
  const { design, designDispatch } = useDesignStore();
  const activeMission = state.activeMissionId ? state.missions[state.activeMissionId] : null;
  const cwd = activeMission?.cwd ?? state.workspaceCwds[0] ?? '';

  useEffect(() => {
    if (!design.studioOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') designDispatch({ type: 'CLOSE_STUDIO' });
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [design.studioOpen, designDispatch]);

  // The native browser is an OS layer painted above the DOM; hide it while the
  // full-screen studio is up or it renders over the canvas.
  useEffect(() => {
    if (design.studioOpen && state.browserOpen) {
      dispatch({ type: 'SET_BROWSER_OPEN', open: false });
    }
  }, [design.studioOpen, state.browserOpen, dispatch]);

  return (
    <AnimatePresence>
      {design.studioOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[60] bg-droid-bg"
        >
          {cwd ? (
            <StudioCanvasProvider>
              <StudioShell
                cwd={cwd}
                onClose={() => { designDispatch({ type: 'CLOSE_STUDIO' }); }}
              />
            </StudioCanvasProvider>
          ) : (
            <EmptyState onClose={() => { designDispatch({ type: 'CLOSE_STUDIO' }); }} />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function EmptyState({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      <div data-electron-drag-region className="absolute inset-x-0 top-0 h-11" />
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-droid-border bg-gradient-to-b from-white/[0.06] to-transparent">
          <StudioMark className="h-6 w-6 text-droid-text-secondary" />
        </div>
        <div className="text-[15px] font-medium text-droid-text">No project open</div>
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-droid-text-muted">
          Open a chat or mission in a workspace to start designing on its live canvas.
        </div>
        <button
          onClick={onClose}
          className="mt-5 rounded-lg border border-droid-border px-4 py-2 text-[13px] text-droid-text-secondary transition-colors hover:border-droid-border hover:text-droid-text"
        >
          Close
        </button>
      </div>
    </div>
  );
}
