import type { ReactNode, RefObject } from 'react';
import { MousePointer2, PenLine, RefreshCw, Send, X } from 'lucide-react';

interface BrowserToolbarProps {
  urlInputRef: RefObject<HTMLInputElement | null>;
  urlInput: string;
  designMode: boolean;
  designModeDisabled?: boolean;
  pencilMode: boolean;
  onUrlInputChange: (value: string) => void;
  onOpen: () => void;
  onReload: () => void;
  onToggleDesignMode: () => void;
  onTogglePencilMode: () => void;
  onClose: () => void;
}

export function BrowserToolbar({
  urlInputRef,
  urlInput,
  designMode,
  designModeDisabled,
  pencilMode,
  onUrlInputChange,
  onOpen,
  onReload,
  onToggleDesignMode,
  onTogglePencilMode,
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
          placeholder="https://example.com or http://localhost:3000"
        />
        <IconButton title="Open" onClick={onOpen}>
          <Send className="h-4 w-4" />
        </IconButton>
        <IconButton title="Reload" onClick={onReload}>
          <RefreshCw className="h-4 w-4" />
        </IconButton>
      </form>

      <div className="flex items-center gap-1">
        <IconButton
          title={designModeDisabled ? 'Select a chat before using Design Mode' : 'Design Mode'}
          active={designMode}
          disabled={designModeDisabled}
          onClick={onToggleDesignMode}
        >
          <MousePointer2 className="h-4 w-4" />
        </IconButton>
        <IconButton
          title="Pencil (draw to annotate)"
          active={designMode && pencilMode}
          disabled={!designMode}
          onClick={onTogglePencilMode}
        >
          <PenLine className="h-4 w-4" />
        </IconButton>
        <IconButton title="Hide browser (keep session)" onClick={onClose}>
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
