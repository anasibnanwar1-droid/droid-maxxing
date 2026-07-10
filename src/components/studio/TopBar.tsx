import type { MutableRefObject } from 'react';
import { Laptop, Monitor, Smartphone, Tablet, X } from 'lucide-react';
import type { BrowserViewportMode } from '../../types/bridge';
import { useStudioCanvas, type StudioCanvasState } from './StudioCanvasContext';
import StudioSettingsMenu from './StudioSettingsMenu';
import ThreadHistoryMenu from './ThreadHistoryMenu';

const VIEWPORTS: { mode: BrowserViewportMode; icon: typeof Monitor; label: string }[] = [
  { mode: 'desktop', icon: Monitor, label: 'Desktop' },
  { mode: 'laptop', icon: Laptop, label: 'Laptop' },
  { mode: 'tablet', icon: Tablet, label: 'Tablet' },
  { mode: 'mobile', icon: Smartphone, label: 'Mobile' },
];

export default function TopBar({
  projectName,
  cwd,
  onClose,
  canvasCache,
}: {
  projectName: string;
  cwd: string;
  onClose: () => void;
  canvasCache: MutableRefObject<Record<string, StudioCanvasState>>;
}) {
  const { studio, studioDispatch } = useStudioCanvas();
  const selectedIds = studio.selectedFrameIds;
  const selectedFrame =
    selectedIds.length === 1 ? studio.frames.find((f) => f.id === selectedIds[0]) : undefined;
  // The control drives the selected frame when there's exactly one; otherwise it
  // sets the size the next frame is created at.
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
      className="flex h-11 shrink-0 items-center justify-between border-b border-droid-border px-3"
    >
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-1.5 pl-1">
          <span className="text-[13px] font-semibold tracking-[0.14em] text-droid-text">
            DROIDEX
          </span>
          <span className="rounded bg-[#ee6018]/15 px-1 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-[#ee6018]">
            studio
          </span>
        </div>
        <div className="h-4 w-px bg-white/10" />
        <div
          className="max-w-[220px] truncate text-[12.5px] text-droid-text-secondary"
          title={cwd}
        >
          {projectName}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="no-drag flex items-center gap-0.5 rounded-lg border border-droid-border bg-white/[0.03] p-0.5">
          {VIEWPORTS.map((v) => (
            <button
              key={v.mode}
              title={selectedFrame ? `${v.label} · this frame` : `${v.label} · new frames`}
              onClick={() => { setMode(v.mode); }}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] transition-colors ${
                activeMode === v.mode
                  ? 'bg-white/[0.09] text-droid-text'
                  : 'text-droid-text-muted hover:text-droid-text-secondary'
              }`}
            >
              <v.icon className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">{v.label}</span>
            </button>
          ))}
        </div>
        <ThreadHistoryMenu cwd={cwd} canvasCache={canvasCache} />
        <StudioSettingsMenu />
        <button
          onClick={onClose}
          title="Close studio (Esc)"
          className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-white/10 hover:text-droid-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
