import { useEffect, useState } from 'react';
import { listDnaLibraries, readDesignDna, scanComponentRegistry } from '../../lib/commands';
import { useStudioCanvas, type StudioTool } from './StudioCanvasContext';
import AgentPanel from './AgentPanel';
import TopBar from './TopBar';
import ToolRail from './ToolRail';
import StudioCanvas from './StudioCanvas';
import SelectionContextPanel from './SelectionContextPanel';
import AddFrameDialog from './AddFrameDialog';

const TOOL_KEYS: Record<string, StudioTool> = {
  v: 'select',
  h: 'hand',
  t: 'text',
  p: 'draw',
};

export default function StudioShell({
  cwd,
  onClose,
}: {
  cwd: string;
  onClose: () => void;
}) {
  const { studioDispatch } = useStudioCanvas();
  const [addFrameOpen, setAddFrameOpen] = useState(false);
  const projectName = cwd.split('/').pop() || 'project';

  // Pull project-scoped design data so Components and Libraries have content.
  useEffect(() => {
    if (!cwd) return;
    readDesignDna(cwd);
    listDnaLibraries();
    scanComponentRegistry(cwd);
  }, [cwd]);

  // Tool + frame shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'f') {
        e.preventDefault();
        setAddFrameOpen(true);
        return;
      }
      const tool = TOOL_KEYS[key];
      if (tool) {
        e.preventDefault();
        studioDispatch({ type: 'SET_TOOL', tool });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [studioDispatch]);

  return (
    <div className="flex h-full w-full bg-droid-bg">
      <AgentPanel cwd={cwd} />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar projectName={projectName} cwd={cwd} onClose={onClose} />
        <div className="relative min-h-0 flex-1">
          <StudioCanvas onRequestAddFrame={() => { setAddFrameOpen(true); }} />

          <div className="absolute left-3 top-1/2 z-20 -translate-y-1/2">
            <ToolRail onRequestAddFrame={() => { setAddFrameOpen(true); }} />
          </div>

          <SelectionContextPanel />

          {addFrameOpen && <AddFrameDialog onClose={() => { setAddFrameOpen(false); }} />}
        </div>
      </div>
    </div>
  );
}
