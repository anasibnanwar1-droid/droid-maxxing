import type { CSSProperties } from 'react';
import type { BrowserBox, BrowserElementRef } from '../../types/bridge';

interface DesignModeOverlayProps {
  refs: BrowserElementRef[];
  selectedIds: string[];
  active: boolean;
  draftRegion?: BrowserBox | null;
  agentCursor?: { x: number; y: number };
}

export function DesignModeOverlay({ refs, selectedIds, active, draftRegion, agentCursor }: DesignModeOverlayProps) {
  const selected = new Set(selectedIds);

  return (
    <div className="pointer-events-none absolute inset-0">
      {active && refs.map((ref) => {
        const isSelected = selected.has(ref.ref);
        return (
          <div
            key={ref.ref}
            className={`absolute border ${isSelected ? 'border-droid-accent' : 'border-droid-accent/35'}`}
            style={boxStyle(ref.box, isSelected ? 'rgba(238, 96, 24, 0.12)' : 'rgba(238, 96, 24, 0.04)')}
          >
            {isSelected && (
              <span className="absolute -left-px -top-6 h-6 max-w-[220px] truncate rounded-t bg-droid-accent px-2 text-[11px] font-medium leading-6 text-black">
                {labelForRef(ref)}
              </span>
            )}
          </div>
        );
      })}

      {draftRegion && (
        <div
          className="absolute border border-droid-accent bg-droid-accent/10"
          style={boxStyle(draftRegion)}
        />
      )}

      {agentCursor && (
        <div
          className="absolute h-4 w-4 -translate-x-1 -translate-y-1"
          style={{ left: agentCursor.x, top: agentCursor.y }}
        >
          <div className="h-3 w-3 rotate-45 border-l border-t border-droid-green bg-droid-bg/80" />
        </div>
      )}
    </div>
  );
}

function labelForRef(ref: BrowserElementRef): string {
  const label = ref.name || ref.text || ref.role || ref.tagName;
  return `${label} - ${ref.tagName.toLowerCase()}`;
}

function boxStyle(box: BrowserBox, backgroundColor?: string): CSSProperties {
  return {
    left: box.x,
    top: box.y,
    width: box.width,
    height: box.height,
    backgroundColor,
  };
}
