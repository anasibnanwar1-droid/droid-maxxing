import type { ReactNode, RefObject } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  Globe2,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MousePointer2,
  PenLine,
  RefreshCw,
} from 'lucide-react';
import { HoverTooltip } from '../HoverTooltip';

interface BrowserToolbarProps {
  urlInputRef: RefObject<HTMLInputElement | null>;
  urlInput: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  designMode: boolean;
  designModeDisabled?: boolean;
  pencilMode: boolean;
  expanded?: boolean;
  onUrlInputChange: (value: string) => void;
  onOpen: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onToggleDesignMode: () => void;
  onTogglePencilMode: () => void;
  onToggleExpanded?: () => void;
}

export function BrowserToolbar({
  urlInputRef,
  urlInput,
  canGoBack,
  canGoForward,
  loading,
  designMode,
  designModeDisabled,
  pencilMode,
  expanded,
  onUrlInputChange,
  onOpen,
  onGoBack,
  onGoForward,
  onReload,
  onToggleDesignMode,
  onTogglePencilMode,
  onToggleExpanded,
}: BrowserToolbarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-droid-border bg-droid-bg/95 px-2.5">
      <IconButton
        title="Back: return to the previous page (⌘[)"
        disabled={!canGoBack || loading}
        onClick={onGoBack}
      >
        <ArrowLeft className="h-4 w-4" />
      </IconButton>
      <IconButton
        title="Forward: go to the next page in history (⌘])"
        disabled={!canGoForward || loading}
        onClick={onGoForward}
      >
        <ArrowRight className="h-4 w-4" />
      </IconButton>
      <form
        className="group flex h-8 min-w-0 flex-1 items-center rounded-lg border border-droid-border bg-droid-surface/75 px-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] transition-colors focus-within:border-droid-border-hover focus-within:bg-droid-surface"
        onSubmit={(event) => {
          event.preventDefault();
          onOpen();
        }}
      >
        <Globe2 className="mr-2 h-3.5 w-3.5 shrink-0 text-droid-text-muted/75" />
        <input
          ref={urlInputRef}
          value={urlInput}
          onChange={(event) => {
            onUrlInputChange(event.target.value);
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] font-medium tracking-[-0.01em] text-droid-text outline-none placeholder:font-normal placeholder:text-droid-text-muted/70"
          placeholder="Search or enter URL"
          aria-label="Browser address"
        />
        <HoverTooltip label="Open address">
          <button
            type="submit"
            aria-label="Open address"
            className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent"
          >
            <CornerDownLeft className="h-3.5 w-3.5" />
          </button>
        </HoverTooltip>
      </form>

      <IconButton
        title={loading ? 'Loading page' : 'Reload: refresh the current page (⌘R)'}
        onClick={onReload}
      >
        {loading ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
      </IconButton>

      <div className="flex items-center gap-0.5 border-l border-droid-border pl-1.5">
        {onToggleExpanded && (
          <IconButton
            title={
              expanded
                ? 'Collapse: return the browser to the utility pane'
                : 'Expand: use the full workspace for the browser'
            }
            active={expanded}
            onClick={onToggleExpanded}
          >
            {expanded ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </IconButton>
        )}
        <IconButton
          title={
            designModeDisabled
              ? 'Select a chat before using Design Mode'
              : 'Design Mode: select components or drag over text, then describe a UI change'
          }
          active={designMode}
          disabled={designModeDisabled}
          onClick={onToggleDesignMode}
        >
          <MousePointer2 className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          title="Annotate: sketch a region or mark up the page for Droid"
          active={designMode && pencilMode}
          disabled={!designMode}
          onClick={onTogglePencilMode}
        >
          <PenLine className="h-3.5 w-3.5" />
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
    <HoverTooltip label={title}>
      <button
        type="button"
        aria-label={title}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-droid-accent disabled:cursor-not-allowed disabled:opacity-35 ${
          active
            ? 'bg-droid-accent/15 text-droid-accent'
            : 'text-droid-text-muted hover:bg-droid-elevated hover:text-droid-text'
        }`}
      >
        {children}
      </button>
    </HoverTooltip>
  );
}
