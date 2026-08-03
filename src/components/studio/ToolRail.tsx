import { Frame, Hand, MousePointer2, Pencil } from 'lucide-react';
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

const ANNOTATE: ToolDef[] = [{ id: 'draw', icon: Pencil, label: 'Draw', key: 'P' }];

/**
 * Left-edge tool rail. Select/Hand drive canvas interaction; Frame opens the add
 * dialog; Draw opens the annotation tools that become context for the agent.
 */
export default function ToolRail({ onRequestAddFrame }: { onRequestAddFrame: () => void }) {
  const { studio, studioDispatch } = useStudioCanvas();
  const setTool = (tool: StudioTool) => {
    studioDispatch({ type: 'SET_TOOL', tool });
  };

  return (
    <div className="studio-floating-surface flex flex-col items-center gap-1 rounded-xl p-1">
      {PRIMARY.map((t) => (
        <RailButton
          key={t.id}
          active={studio.tool === t.id}
          label={t.label}
          shortcut={t.key}
          onClick={() => {
            setTool(t.id);
          }}
        >
          <t.icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </RailButton>
      ))}

      <Divider />

      <RailButton label="Add frame" shortcut="F" onClick={onRequestAddFrame}>
        <Frame className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </RailButton>

      <Divider />

      {ANNOTATE.map((t) => (
        <RailButton
          key={t.id}
          active={studio.tool === t.id}
          label={t.label}
          shortcut={t.key}
          onClick={() => {
            setTool(t.id);
          }}
        >
          <t.icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </RailButton>
      ))}
    </div>
  );
}

function Divider() {
  return <div className="my-0.5 h-px w-5 bg-droid-border" />;
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
      aria-pressed={active}
      className={`group relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-150 ${
        active
          ? 'bg-droid-accent/10 text-droid-accent'
          : 'text-droid-text-muted hover:bg-droid-active/70 hover:text-droid-text'
      }`}
    >
      {children}
      <span className="pointer-events-none absolute left-full ml-2.5 flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-droid-border bg-droid-elevated px-2 py-1 text-[11px] text-droid-text opacity-0 shadow-lg transition-opacity delay-200 duration-150 group-hover:opacity-100">
        {label}
        {shortcut && (
          <kbd className="rounded bg-droid-active px-1 text-[10px] text-droid-text-secondary">
            {shortcut}
          </kbd>
        )}
      </span>
    </button>
  );
}
