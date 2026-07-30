import { useEffect, useState } from 'react';
import { listDnaLibraries, readDesignDna, scanComponentRegistry } from '../../lib/commands';
import { usePreviewFrames } from './usePreviewFrames';
import AgentPanel from './AgentPanel';
import TopBar from './TopBar';
import ToolRail from './ToolRail';
import StudioCanvas from './StudioCanvas';
import SelectionContextPanel from './SelectionContextPanel';
import AddFrameDialog from './AddFrameDialog';

export default function StudioShell({
  cwd,
  sessionKey,
  repositoryCwds,
  onSelectRepository,
  onAddRepository,
  onClose,
}: {
  /** Agent workspace (may be isolated worktree). */
  cwd: string;
  /** Stable live project path for session/thread keys. */
  sessionKey: string;
  repositoryCwds: string[];
  onSelectRepository: (cwd: string) => void;
  onAddRepository: () => Promise<void>;
  onClose: () => void;
}) {
  const [addFrameOpen, setAddFrameOpen] = useState(false);
  const [isAgentPanelOpen, setIsAgentPanelOpen] = useState(true);
  usePreviewFrames(cwd);

  useEffect(() => {
    if (!cwd) return;
    readDesignDna(cwd);
    listDnaLibraries();
    scanComponentRegistry(cwd);
  }, [cwd]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setIsAgentPanelOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="studio-shell flex h-full w-full bg-droid-bg">
      <div
        aria-hidden={!isAgentPanelOpen}
        inert={!isAgentPanelOpen}
        className={`h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
          isAgentPanelOpen ? 'w-[352px]' : 'pointer-events-none w-0'
        }`}
      >
        <AgentPanel cwd={cwd} sessionKey={sessionKey} onBack={onClose} />
      </div>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar
          repositoryCwds={repositoryCwds}
          selectedRepositoryCwd={sessionKey}
          onSelectRepository={onSelectRepository}
          onAddRepository={onAddRepository}
          isAgentPanelOpen={isAgentPanelOpen}
          onToggleAgentPanel={() => {
            setIsAgentPanelOpen((open) => !open);
          }}
        />
        <div className="relative min-h-0 flex-1">
          <StudioCanvas
            cwd={cwd}
            onRequestAddFrame={() => {
              setAddFrameOpen(true);
            }}
          />

          <div className="absolute left-3 top-1/2 z-20 -translate-y-1/2">
            <ToolRail
              onRequestAddFrame={() => {
                setAddFrameOpen(true);
              }}
            />
          </div>

          <SelectionContextPanel />

          {addFrameOpen && (
            <AddFrameDialog
              onClose={() => {
                setAddFrameOpen(false);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
