import { Frame, Hand, MousePointer2, Pencil, Type } from 'lucide-react';
import { useStudioCanvas, type StudioTool } from './StudioCanvasContext';

interface ToolDef {
  id: StudioTool;
  icon: typeof MousePointer2;
  label: string;
  key: string;
}

const PRIMARY: ToolDef[] = [
  { id: 'select', icon: MousePointer2, label: 'Select', key: 'V' },
  { id: 'hand', icon: Hand, label: 'Hand', key: 'H' },
];

const ANNOTATE: ToolDef[] = [
  { id: 'text', icon: Type, label: 'Text', key: 'T' },
  { id: 'draw', icon: Pencil, label: 'Draw', key: 'P' },
];

/**
 * Left-edge tool rail. Select/Hand drive canvas interaction; Frame opens the add
 * dialog; Text/Draw arm annotation tools that become context for the agent.
 */
export default function ToolRail({ onRequestAddFrame }: { onRequestAddFrame: () => void }) {
  const { studio, studioDispatch } = useStudioCanvas();
  const setTool = (tool: StudioTool) => { studioDispatch({ type: 'SET_TOOL', tool }); };

  return (
    <div className="flex flex-col items-center gap-1 rounded-2xl border border-white/[0.08] bg-[#111]/85 p-1.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)] backdrop-blur">
      {PRIMARY.map((t) => (
        <RailButton
          key={t.id}
          active={studio.tool === t.id}
          label={t.label}
          shortcut={t.key}
          onClick={() => { setTool(t.id); }}
        >
          <t.icon className="h-[18px] w-[18px]" />
        </RailButton>
      ))}

      <Divider />

      <RailButton label="Add frame" shortcut="F" onClick={onRequestAddFrame}>
        <Frame className="h-[18px] w-[18px]" />
      </RailButton>

      <Divider />

      {ANNOTATE.map((t) => (
        <RailButton
          key={t.id}
          active={studio.tool === t.id}
          label={t.label}
          shortcut={t.key}
          onClick={() => { setTool(t.id); }}
        >
          <t.icon className="h-[18px] w-[18px]" />
        </RailButton>
      ))}
    </div>
  );
}

function Divider() {
  return <div className="my-0.5 h-px w-5 bg-white/[0.08]" />;
}

function RailButton({
  children,
  active,
  label,
  shortcut,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`group relative flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-150 ${
        active
          ? 'bg-[#ee6018]/15 text-[#ee6018] shadow-[inset_0_0_0_1px_rgba(238,96,24,0.4)]'
          : 'text-white/50 hover:bg-white/[0.06] hover:text-white/90'
      }`}
    >
      {children}
      <span className="pointer-events-none absolute left-full ml-3 flex items-center gap-1.5 whitespace-nowrap rounded-md border border-white/10 bg-[#1a1a1a] px-2 py-1 text-[11px] text-white/80 opacity-0 shadow-xl transition-opacity delay-200 duration-150 group-hover:opacity-100">
        {label}
        {shortcut && (
          <kbd className="rounded bg-white/10 px-1 font-mono text-[10px] text-white/60">
            {shortcut}
          </kbd>
        )}
      </span>
    </button>
  );
}
