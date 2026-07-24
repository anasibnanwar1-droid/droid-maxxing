import type { UtilityTool } from '../../lib/utilityPanel';
import { utilityToolOption } from './utilityToolOptions';

export function UtilityToolPicker({
  tools,
  onSelect,
  spacious = false,
}: {
  tools: UtilityTool[];
  onSelect: (tool: UtilityTool) => void;
  spacious?: boolean;
}) {
  return (
    <div
      role="menu"
      aria-label="Utility tools"
      className={spacious ? 'flex w-full flex-col gap-2' : 'p-1.5'}
    >
      {tools.map((tool) => {
        const option = utilityToolOption(tool);
        const Icon = option.icon;
        return (
          <button
            key={tool}
            type="button"
            role="menuitem"
            onClick={() => {
              onSelect(tool);
            }}
            className={
              spacious
                ? 'group flex h-12 w-full items-center gap-3 rounded-lg border border-white/[0.025] bg-droid-surface/75 px-3.5 text-left text-[13px] text-droid-text-secondary shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-colors hover:border-droid-border-hover hover:bg-droid-elevated hover:text-droid-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent'
                : 'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[12.5px] text-droid-text-secondary transition-colors hover:bg-droid-elevated/60 hover:text-droid-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent'
            }
          >
            <Icon
              className={`shrink-0 text-droid-text-muted transition-colors group-hover:text-droid-text ${
                spacious ? 'h-4 w-4' : 'h-3.5 w-3.5'
              }`}
            />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <kbd
              className={`shrink-0 rounded-md bg-white/[0.055] font-mono text-droid-text-muted ${
                spacious ? 'px-2 py-0.5 text-[10px]' : 'px-1.5 py-0.5 text-[9.5px]'
              }`}
            >
              {option.shortcut}
            </kbd>
          </button>
        );
      })}
    </div>
  );
}
