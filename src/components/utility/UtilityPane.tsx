import { useRef, useState, type ReactNode } from 'react';
import { PanelRightClose, Plus, X } from 'lucide-react';
import { HoverTooltip } from '../HoverTooltip';
import { Popover } from '../environment/Popover';
import type { UtilityPanelState, UtilityTab, UtilityTool } from '../../lib/utilityPanel';
import { PaneResizeHandle } from './PaneResizeHandle';
import { UtilityToolPicker } from './UtilityToolPicker';
import { UTILITY_TOOL_OPTIONS, utilityToolOption } from './utilityToolOptions';

export function UtilityPane({
  panel,
  width,
  minWidth,
  maxWidth,
  onResize,
  onResizeEnd,
  onOpenTool,
  onActivateTab,
  onCloseTab,
  onClosePane,
  renderTab,
  expanded = false,
}: {
  panel: UtilityPanelState;
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onOpenTool: (tool: UtilityTool) => void;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tab: UtilityTab) => void;
  onClosePane: () => void;
  renderTab: (tab: UtilityTab, context: { overlayOpen: boolean }) => ReactNode;
  expanded?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId) ?? null;
  const openSingletons = new Set(panel.tabs.map((tab) => tab.tool));
  const availableTools = UTILITY_TOOL_OPTIONS.map((option) => option.tool).filter(
    (tool) => tool === 'terminal' || !openSingletons.has(tool),
  );

  return (
    <aside
      aria-label="Utility pane"
      className={`relative flex h-full min-w-0 flex-col overflow-hidden bg-droid-bg ${
        expanded
          ? 'w-full border-l-0 shadow-none'
          : 'w-full border-l border-droid-border shadow-[-24px_0_60px_rgba(0,0,0,0.18)]'
      }`}
    >
      {!expanded && (
        <PaneResizeHandle
          width={width}
          min={minWidth}
          max={maxWidth}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
        />
      )}

      <header
        data-electron-drag-region
        className="flex h-9 shrink-0 items-center gap-1 border-b border-droid-border bg-droid-bg/95 pl-3 pr-2"
      >
        <div
          role="tablist"
          aria-label="Open utility tools"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {panel.tabs.map((tab) => {
            const Icon = utilityToolOption(tab.tool).icon;
            const active = tab.id === panel.activeTabId;
            return (
              <div
                key={tab.id}
                className={`group flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors ${
                  active
                    ? 'bg-droid-elevated text-droid-text'
                    : 'text-droid-text-muted hover:bg-droid-elevated/45 hover:text-droid-text'
                }`}
              >
                <button
                  role="tab"
                  aria-selected={active}
                  title={tab.label}
                  onClick={() => {
                    onActivateTab(tab.id);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-1.5 focus:outline-none"
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{tab.label}</span>
                </button>
                <HoverTooltip label={`Close ${tab.label}`} placement="bottom">
                  <button
                    type="button"
                    aria-label={`Close ${tab.label}`}
                    className="ml-0.5 rounded p-0.5 text-droid-text-muted opacity-60 transition hover:bg-droid-border hover:text-droid-text group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(tab);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </HoverTooltip>
              </div>
            );
          })}
        </div>

        <HoverTooltip label="Open another tool" placement="bottom">
          <button
            ref={addRef}
            type="button"
            aria-label="Open another tool"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((open) => !open);
            }}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
              menuOpen
                ? 'bg-droid-elevated text-droid-text'
                : 'text-droid-text-muted hover:bg-droid-elevated/60 hover:text-droid-text'
            }`}
          >
            <Plus className="h-4 w-4" />
          </button>
        </HoverTooltip>
        <HoverTooltip label="Hide utility pane" placement="bottom">
          <button
            type="button"
            aria-label="Hide utility pane"
            onClick={onClosePane}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-elevated/60 hover:text-droid-text"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </HoverTooltip>
      </header>

      <Popover
        open={menuOpen}
        onClose={() => {
          setMenuOpen(false);
        }}
        anchorRef={addRef}
        align="right"
        width={236}
        label="Open utility tool"
      >
        <div>
          <UtilityToolPicker
            tools={availableTools}
            onSelect={(tool) => {
              setMenuOpen(false);
              onOpenTool(tool);
            }}
          />
          {availableTools.length === 0 && (
            <div className="px-2 py-2 text-[12px] text-droid-text-muted">
              All utility tools are open.
            </div>
          )}
        </div>
      </Popover>

      <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
        {activeTab ? (
          renderTab(activeTab, { overlayOpen: menuOpen })
        ) : (
          <div className="flex h-full items-center justify-center px-3 pb-[8vh]">
            <div className="w-full max-w-xl">
              <UtilityToolPicker
                spacious
                tools={UTILITY_TOOL_OPTIONS.map((option) => option.tool)}
                onSelect={onOpenTool}
              />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
