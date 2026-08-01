import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../../hooks/useStore';
import { useDesignStore } from '../../hooks/useDesignStore';
import { prepareDesignWorkspace } from '../../lib/commands';
import { pickDirectory } from '../../lib/desktop';
import { pushEscapeLayer } from '../environment/usePopover';
import { StudioCanvasProvider } from '../studio/StudioCanvasContext';
import StudioShell from '../studio/StudioShell';
import {
  canonicalLiveProjectCwd,
  studioRepositoryCwds,
  studioWorkspaceAccess,
} from './designStudioProject';

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
  const knownWorkspaces = Object.values(design.workspaces);
  const preferredLiveCwd = canonicalLiveProjectCwd(
    activeSession?.cwd ?? firstWorkspaceCwd,
    knownWorkspaces,
  );
  const [selectedLiveCwd, setSelectedLiveCwd] = useState('');
  const liveCwd = selectedLiveCwd || preferredLiveCwd;
  const repositoryCwds = studioRepositoryCwds(
    preferredLiveCwd,
    state.workspaceCwds,
    knownWorkspaces,
  );
  const workspace = liveCwd ? design.workspaces[liveCwd] : undefined;
  const workspaceError = design.lastError?.cwd === liveCwd ? design.lastError.message : undefined;
  const workspaceAccess = studioWorkspaceAccess(liveCwd, workspace, workspaceError);

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
    if (liveCwd in design.workspaces || design.lastError?.cwd === liveCwd) return;
    prepareDesignWorkspace(liveCwd);
  }, [design.studioOpen, liveCwd, design.workspaces, design.lastError]);

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
          {workspaceAccess.kind === 'ready' && (
            <StudioCanvasProvider key={liveCwd}>
              <StudioShell
                cwd={workspaceAccess.cwd}
                sessionKey={liveCwd}
                repositoryCwds={repositoryCwds}
                onSelectRepository={setSelectedLiveCwd}
                onAddRepository={addRepository}
                onClose={() => {
                  designDispatch({ type: 'CLOSE_STUDIO' });
                }}
              />
            </StudioCanvasProvider>
          )}
          {(workspaceAccess.kind === 'loading' || workspaceAccess.kind === 'error') && (
            <WorkspaceState
              error={workspaceAccess.kind === 'error' ? workspaceAccess.message : undefined}
              onRetry={() => {
                designDispatch({ type: 'CLEAR_ERROR' });
              }}
              onClose={() => {
                designDispatch({ type: 'CLOSE_STUDIO' });
              }}
            />
          )}
          {workspaceAccess.kind === 'empty' && (
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

function WorkspaceState({
  error,
  onRetry,
  onClose,
}: {
  error?: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-6">
      <div data-electron-drag-region className="absolute inset-x-0 top-0 h-11" />
      <div className="max-w-md text-center">
        <div className="text-[15px] font-medium text-droid-text">
          {error ? 'Could not open an isolated workspace' : 'Preparing isolated workspace…'}
        </div>
        <div className="mt-2 text-[12.5px] leading-relaxed text-droid-text-muted">
          {error ??
            'DROIDEX Design is creating a dedicated Git worktree before prompts are enabled.'}
        </div>
        {error && (
          <div className="mt-5 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg bg-droid-text px-4 py-2 text-[12.5px] font-medium text-droid-bg"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-droid-border px-4 py-2 text-[12.5px] text-droid-text-secondary"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
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
