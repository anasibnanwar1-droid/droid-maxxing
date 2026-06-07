import type { ComponentType, ReactNode, RefObject } from 'react';
import {
  Expand,
  Laptop,
  MousePointer2,
  Monitor,
  PenLine,
  RefreshCw,
  Send,
  Smartphone,
  Tablet,
  X,
} from 'lucide-react';
import type { BrowserViewport, BrowserViewportMode } from '../../types/bridge';
import { clamp, PRESET_VIEWPORTS } from './browserViewport';

type Preset = {
  id: BrowserViewportMode;
  label: string;
  icon: ComponentType<{ className?: string }>;
  viewport?: BrowserViewport;
};

const PRESETS: Preset[] = [
  { id: 'fit', label: 'Fit', icon: Expand },
  { id: 'desktop', label: 'Desktop', icon: Monitor, viewport: PRESET_VIEWPORTS.desktop },
  { id: 'laptop', label: 'Laptop', icon: Laptop, viewport: PRESET_VIEWPORTS.laptop },
  { id: 'tablet', label: 'Tablet', icon: Tablet, viewport: PRESET_VIEWPORTS.tablet },
  { id: 'mobile', label: 'Mobile', icon: Smartphone, viewport: PRESET_VIEWPORTS.mobile },
];

interface BrowserToolbarProps {
  urlInputRef: RefObject<HTMLInputElement | null>;
  urlInput: string;
  viewportMode: BrowserViewportMode;
  customViewport: BrowserViewport;
  designMode: boolean;
  sketchMode: boolean;
  onUrlInputChange: (value: string) => void;
  onOpen: () => void;
  onReload: () => void;
  onViewportModeChange: (mode: BrowserViewportMode) => void;
  onCustomViewportChange: (viewport: BrowserViewport) => void;
  onToggleDesignMode: () => void;
  onToggleSketchMode: () => void;
  onClose: () => void;
}

export function BrowserToolbar({
  urlInputRef,
  urlInput,
  viewportMode,
  customViewport,
  designMode,
  sketchMode,
  onUrlInputChange,
  onOpen,
  onReload,
  onViewportModeChange,
  onCustomViewportChange,
  onToggleDesignMode,
  onToggleSketchMode,
  onClose,
}: BrowserToolbarProps) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-droid-border bg-droid-bg/95 px-3 py-2">
      <form
        className="flex min-w-[280px] flex-1 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onOpen();
        }}
      >
        <input
          ref={urlInputRef}
          value={urlInput}
          onChange={(event) => onUrlInputChange(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border border-droid-border bg-droid-surface px-3 text-[13px] text-droid-text placeholder:text-droid-text-muted focus:border-droid-border-hover focus:outline-none"
          placeholder="https://example.com"
        />
        <IconButton title="Open" onClick={onOpen}>
          <Send className="h-4 w-4" />
        </IconButton>
        <IconButton title="Reload" onClick={onReload}>
          <RefreshCw className="h-4 w-4" />
        </IconButton>
      </form>

      <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-md border border-droid-border bg-droid-surface p-1">
        {PRESETS.map((preset) => {
          const Icon = preset.icon;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onViewportModeChange(preset.id)}
              className={`flex h-7 items-center gap-1.5 rounded px-2 text-[12px] transition-colors ${
                viewportMode === preset.id
                  ? 'bg-droid-elevated text-droid-text'
                  : 'text-droid-text-muted hover:text-droid-text'
              }`}
              title={`${preset.label} viewport`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{preset.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onViewportModeChange('custom')}
          className={`flex h-7 items-center gap-1.5 rounded px-2 text-[12px] transition-colors ${
            viewportMode === 'custom'
              ? 'bg-droid-elevated text-droid-text'
              : 'text-droid-text-muted hover:text-droid-text'
          }`}
          title="Custom viewport"
        >
          <span className="font-mono text-[11px]">W</span>
          <span className="hidden sm:inline">Custom</span>
        </button>
      </div>

      {viewportMode === 'custom' && (
        <div className="flex items-center gap-1 rounded-md border border-droid-border bg-droid-surface px-1.5 py-1">
          <ViewportInput
            label="Width"
            value={customViewport.width}
            onChange={(width) => onCustomViewportChange({ ...customViewport, width })}
          />
          <span className="text-[11px] text-droid-text-muted">x</span>
          <ViewportInput
            label="Height"
            value={customViewport.height}
            onChange={(height) => onCustomViewportChange({ ...customViewport, height })}
          />
        </div>
      )}

      <div className="flex items-center gap-1">
        <IconButton title="Design Mode" active={designMode} onClick={onToggleDesignMode}>
          <MousePointer2 className="h-4 w-4" />
        </IconButton>
        <IconButton
          title="Sketch Region"
          active={designMode && sketchMode}
          disabled={!designMode}
          onClick={onToggleSketchMode}
        >
          <PenLine className="h-4 w-4" />
        </IconButton>
        <IconButton title="Close Browser" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
    </header>
  );
}

function IconButton({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-droid-border transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? 'bg-droid-accent text-black'
          : 'bg-droid-surface text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated'
      }`}
    >
      {children}
    </button>
  );
}

function ViewportInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      aria-label={label}
      type="number"
      min={240}
      max={2400}
      value={value}
      onChange={(event) => onChange(clamp(parseInt(event.target.value, 10) || value, 240, 2400))}
      className="h-6 w-16 rounded border border-droid-border bg-droid-bg px-1.5 text-right font-mono text-[11px] text-droid-text focus:border-droid-border-hover focus:outline-none"
    />
  );
}
