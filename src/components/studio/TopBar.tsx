import { PanelLeft } from 'lucide-react';
import type { BrowserViewportMode } from '../../types/bridge';
import { useStudioCanvas } from './StudioCanvasContext';
import RepositorySelector from './RepositorySelector';
import StudioSettingsMenu from './StudioSettingsMenu';

const VIEWPORTS: { mode: BrowserViewportMode; label: string }[] = [
  { mode: 'desktop', label: 'Desktop' },
  { mode: 'laptop', label: 'Laptop' },
  { mode: 'tablet', label: 'Tablet' },
  { mode: 'mobile', label: 'Mobile' },
];

export default function TopBar({
  repositoryCwds,
  selectedRepositoryCwd,
  onSelectRepository,
  onAddRepository,
  isAgentPanelOpen,
  onToggleAgentPanel,
}: {
  repositoryCwds: string[];
  selectedRepositoryCwd: string;
  onSelectRepository: (cwd: string) => void;
  onAddRepository: () => Promise<void>;
  isAgentPanelOpen: boolean;
  onToggleAgentPanel: () => void;
}) {
  const { studio, studioDispatch } = useStudioCanvas();
  const selectedIds = studio.selectedFrameIds;
  const selectedFrame =
    selectedIds.length === 1 ? studio.frames.find((f) => f.id === selectedIds[0]) : undefined;
  const activeMode = selectedFrame?.mode ?? studio.defaultMode;

  const setMode = (mode: BrowserViewportMode) => {
    if (selectedFrame) {
      studioDispatch({ type: 'UPDATE_FRAME', id: selectedFrame.id, patch: { mode } });
    } else {
      studioDispatch({ type: 'SET_DEFAULT_MODE', mode });
    }
  };

  return (
    <div
      data-electron-drag-region
      className="flex h-[52px] shrink-0 items-center justify-between border-b border-droid-border bg-droid-bg/95 px-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={onToggleAgentPanel}
          title={`${isAgentPanelOpen ? 'Hide' : 'Show'} agent panel (Cmd+\\)`}
          aria-pressed={isAgentPanelOpen}
          className="no-drag flex h-8 w-8 items-center justify-center rounded-lg text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          <PanelLeft className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <div className="h-4 w-px bg-droid-border" />
        <div className="shrink-0 text-[12.5px] font-medium text-droid-text">Canvas</div>
        <RepositorySelector
          repositoryCwds={repositoryCwds}
          selectedCwd={selectedRepositoryCwd}
          onSelect={onSelectRepository}
          onAdd={onAddRepository}
          onOpen={() => {
            studioDispatch({ type: 'SET_INTERACTING', id: null });
          }}
        />
        {selectedFrame && (
          <div className="min-w-0 truncate text-[12px] text-droid-text-muted">
            / {selectedFrame.name}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="no-drag flex items-center gap-0.5 rounded-lg bg-droid-surface p-0.5">
          {VIEWPORTS.map((v) => (
            <button
              key={v.mode}
              title={selectedFrame ? `${v.label} · this frame` : `${v.label} · new frames`}
              aria-pressed={activeMode === v.mode}
              onClick={() => {
                setMode(v.mode);
              }}
              className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                activeMode === v.mode
                  ? 'bg-droid-active text-droid-text'
                  : 'text-droid-text-muted hover:text-droid-text'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <StudioSettingsMenu />
      </div>
    </div>
  );
}
