import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useDesignStore, type StudioTab } from '../../hooks/useDesignStore';
import {
  listDesignLibrary,
  listDnaLibraries,
  listPrototypes,
  readDesignDna,
  readValidatorConfig,
  scanComponentRegistry,
} from '../../lib/commands';
import ComponentsTab from '../design/ComponentsTab';
import DnaTab from '../design/DnaTab';
import LibraryTab from '../design/LibraryTab';
import PrototypesTab from '../design/PrototypesTab';
import ValidatorTab from '../design/ValidatorTab';
import { usePreviewFrames } from './usePreviewFrames';
import { useStudioCanvasPersistence } from './useStudioCanvasPersistence';
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
  const { design, designDispatch } = useDesignStore();
  const [addFrameOpen, setAddFrameOpen] = useState(false);
  const [isAgentPanelOpen, setIsAgentPanelOpen] = useState(true);
  const { notices, isHydrating } = useStudioCanvasPersistence(cwd, sessionKey);
  usePreviewFrames(cwd, !isHydrating);

  useEffect(() => {
    if (!cwd) return;
    readDesignDna(cwd);
    listDnaLibraries();
    readValidatorConfig(cwd);
    listDesignLibrary(cwd);
    listPrototypes(cwd);
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

  const rawSessionId = design.sessions[sessionKey] ?? design.sessions[cwd];
  const appSessionId = rawSessionId ? rawSessionId : null;

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
          {design.lastError &&
            (!design.lastError.cwd ||
              design.lastError.cwd === cwd ||
              design.lastError.cwd === sessionKey) && (
              <div
                role="alert"
                className="studio-popover absolute left-1/2 top-3 z-50 flex max-w-[560px] -translate-x-1/2 items-start gap-3 px-3 py-2 text-[11.5px] leading-relaxed text-droid-text-secondary"
              >
                <span className="min-w-0 flex-1">{design.lastError.message}</span>
                <button
                  type="button"
                  aria-label="Dismiss error"
                  title="Dismiss"
                  onClick={() => {
                    designDispatch({ type: 'CLEAR_ERROR' });
                  }}
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-active hover:text-droid-text"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </div>
            )}
          {design.studioTab === 'canvas' ? (
            <>
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

              {isHydrating && (
                <div className="absolute inset-0 z-40 flex items-center justify-center bg-droid-bg/55 backdrop-blur-[1px]">
                  <div className="studio-popover px-3 py-2 text-[11.5px] text-droid-text-secondary">
                    Restoring canvas…
                  </div>
                </div>
              )}

              {notices.length > 0 && (
                <div
                  role="status"
                  className="studio-popover absolute left-1/2 top-3 z-30 max-w-[520px] -translate-x-1/2 px-3 py-2 text-[11.5px] leading-relaxed text-droid-text-secondary"
                >
                  {notices[0]}
                </div>
              )}

              {addFrameOpen && (
                <AddFrameDialog
                  onClose={() => {
                    setAddFrameOpen(false);
                  }}
                />
              )}
            </>
          ) : (
            <StudioFeatureSurface tab={design.studioTab} cwd={cwd} appSessionId={appSessionId} />
          )}
        </div>
      </div>
    </div>
  );
}

function StudioFeatureSurface({
  tab,
  cwd,
  appSessionId,
}: {
  tab: Exclude<StudioTab, 'canvas'>;
  cwd: string;
  appSessionId: string | null;
}) {
  const content = (() => {
    switch (tab) {
      case 'dna':
        return <DnaTab cwd={cwd} appSessionId={appSessionId} />;
      case 'validator':
        return <ValidatorTab cwd={cwd} appSessionId={appSessionId} />;
      case 'library':
        return <LibraryTab cwd={cwd} appSessionId={appSessionId} />;
      case 'prototypes':
        return <PrototypesTab cwd={cwd} appSessionId={appSessionId} />;
      case 'components':
        return <ComponentsTab cwd={cwd} appSessionId={appSessionId} />;
    }
  })();
  return <div className="h-full min-h-0 overflow-y-auto p-6">{content}</div>;
}
