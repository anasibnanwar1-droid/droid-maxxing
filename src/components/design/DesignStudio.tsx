import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../../hooks/useStore';
import { useDesignStore } from '../../hooks/useDesignStore';
import { prepareDesignWorkspace } from '../../lib/commands';
import { pickDirectory } from '../../lib/desktop';
import { pushEscapeLayer } from '../environment/usePopover';
import { StudioCanvasProvider } from '../studio/StudioCanvasContext';
import StudioShell from '../studio/StudioShell';

/**
 * DROIDEX Studio — a full-screen, agent-native design surface: an infinite live
 * canvas of frames with a project agent chat. Opened via the Sidebar entry or
 * ⌘⇧D; closed with Escape. State lives in a self-contained canvas context.
 *
 * The studio resolves an isolated design workspace (git worktree on
 * droidex/design when possible) so the agent never writes into the live tree
 * the user's dev server is watching.
 */
export default function DesignStudio() {
  const { state, dispatch } = useStore();
  const { design, designDispatch } = useDesignStore();
  const activeSession = state.activeAppSessionId ? state.sessions[state.activeAppSessionId] : null;
  // Live project path (the user's open workspace / active chat).
  const firstWorkspaceCwd = state.workspaceCwds[0] ?? '';
  const preferredLiveCwd = activeSession?.cwd ?? firstWorkspaceCwd;
  const [selectedLiveCwd, setSelectedLiveCwd] = useState('');
  const liveCwd = selectedLiveCwd || preferredLiveCwd;
  const repositoryCwds = [preferredLiveCwd, ...state.workspaceCwds].filter(
    (candidate, index, all) => candidate !== '' && all.indexOf(candidate) === index,
  );
  // Prefer the isolated worktree once prepared; fall back to live until ready.
  const workspace = liveCwd ? design.workspaces[liveCwd] : undefined;
  const cwd = workspace?.path ?? liveCwd;

  useEffect(() => {
    if (!design.studioOpen) {
      setSelectedLiveCwd('');
      return;
    }
    return pushEscapeLayer(() => {
      designDispatch({ type: 'CLOSE_STUDIO' });
    });
  }, [design.studioOpen, designDispatch]);

  const addRepository = async () => {
    const directory = await pickDirectory();
    if (!directory) return;
    dispatch({ type: 'ADD_WORKSPACE', cwd: directory });
    setSelectedLiveCwd(directory);
  };

  // Prepare the isolated design workspace when the studio opens for a project.
  useEffect(() => {
    if (!design.studioOpen || !liveCwd) return;
    if (liveCwd in design.workspaces) return;
    prepareDesignWorkspace(liveCwd);
  }, [design.studioOpen, liveCwd, design.workspaces]);

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
            <StudioCanvasProvider key={liveCwd}>
              <StudioShell
                cwd={cwd}
                sessionKey={liveCwd}
                repositoryCwds={repositoryCwds}
                onSelectRepository={setSelectedLiveCwd}
                onAddRepository={addRepository}
                onClose={() => {
                  designDispatch({ type: 'CLOSE_STUDIO' });
                }}
              />
            </StudioCanvasProvider>
          ) : (
            <EmptyState
              onClose={() => {
                designDispatch({ type: 'CLOSE_STUDIO' });
              }}
            />
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
        <div className="mb-3 text-[11.5px] font-medium text-droid-text-muted">DROIDEX Studio</div>
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
