import type { CSSProperties } from 'react';
import type { BrowserBox, BrowserElementRef } from '../../types/bridge';
import { labelForBrowserRef } from './designModeTargeting';

interface DesignModeOverlayProps {
  refs: BrowserElementRef[];
  selectedIds: string[];
  active: boolean;
  hoveredRef?: BrowserElementRef | null;
  draftRegion?: BrowserBox | null;
  agentCursor?: { x: number; y: number };
}

export function DesignModeOverlay({
  refs,
  selectedIds,
  active,
  hoveredRef,
  draftRegion,
  agentCursor,
}: DesignModeOverlayProps) {
  const selected = new Set(selectedIds);
  const visibleRefs = refs.filter((ref) => selected.has(ref.ref));
  if (active && hoveredRef && !selected.has(hoveredRef.ref)) visibleRefs.push(hoveredRef);

  return (
    <div className="pointer-events-none absolute inset-0">
      {active && visibleRefs.map((ref) => {
        const isSelected = selected.has(ref.ref);
        return (
          <div
            key={ref.ref}
            className={`absolute border ${isSelected ? 'border-droid-accent' : 'border-droid-accent/80'}`}
            style={boxStyle(ref.box, isSelected ? 'rgba(238, 96, 24, 0.12)' : 'rgba(238, 96, 24, 0.06)')}
          >
            <span
              className={`absolute -left-px -top-6 h-6 max-w-[260px] truncate rounded-t px-2 text-[11px] font-medium leading-6 ${
                isSelected ? 'bg-droid-accent text-black' : 'bg-[#2383d9] text-white'
              }`}
            >
              {isSelected ? (
                labelForBrowserRef(ref)
              ) : (
                <>
                  {labelForBrowserRef(ref)}
                  <span className="ml-2 opacity-80">Click to select</span>
                </>
              )}
            </span>
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

function boxStyle(box: BrowserBox, backgroundColor?: string): CSSProperties {
  return {
    left: box.x,
    top: box.y,
    width: box.width,
    height: box.height,
    backgroundColor,
  };
}
