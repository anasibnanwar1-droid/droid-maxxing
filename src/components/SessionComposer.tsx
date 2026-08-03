import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEventHandler,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, Square } from 'lucide-react';
import type { LiveEnterBehavior } from '../hooks/useStore';
import { resolveSessionPromptMode, type SessionPromptMode } from '../lib/promptQueue';

interface SessionComposerProps {
  value: string;
  onValueChange: (value: string, textarea: HTMLTextAreaElement) => void;
  onSubmit: (mode: SessionPromptMode) => void | Promise<void>;
  isLive: boolean;
  hasContent: boolean;
  canSubmit: boolean;
  liveEnterBehavior: LiveEnterBehavior;
  placeholder: string;
  onStop?: () => void;
  onBeforeKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onSelectionChange?: (textarea: HTMLTextAreaElement) => void;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  onActionOverlayChange?: (open: boolean) => void;
  context?: ReactNode;
  toolbarTop?: ReactNode;
  toolbarLeading?: ReactNode;
  toolbarTrailing?: ReactNode;
  cardClassName?: string;
  cardStyle?: CSSProperties;
  idleSendTitle?: string;
}

function sessionComposerActions(
  isLive: boolean,
  hasContent: boolean,
): { showStop: boolean; showSend: boolean } {
  return {
    showStop: isLive,
    showSend: !isLive || hasContent,
  };
}

const SessionComposer = forwardRef<HTMLTextAreaElement, SessionComposerProps>(
  function SessionComposer(
    {
      value,
      onValueChange,
      onSubmit,
      isLive,
      hasContent,
      canSubmit,
      liveEnterBehavior,
      placeholder,
      onStop,
      onBeforeKeyDown,
      onSelectionChange,
      onPaste,
      onActionOverlayChange,
      context,
      toolbarTop,
      toolbarLeading,
      toolbarTrailing,
      cardClassName = 'border-droid-border focus-within:border-droid-border-hover',
      cardStyle,
      idleSendTitle = 'Enter: send\nShift+Enter: newline',
    },
    forwardedRef,
  ) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const [sendHover, setSendHover] = useState(false);
    const actions = sessionComposerActions(isLive, hasContent);
    const enterSteers = liveEnterBehavior === 'interrupt';
    let sendAriaLabel = 'Send prompt';
    if (isLive) sendAriaLabel = enterSteers ? 'Steer current turn' : 'Queue prompt';

    useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = 'auto';
      textarea.style.height = `${String(Math.min(textarea.scrollHeight, 200))}px`;
    }, [value]);

    useEffect(() => {
      if (!isLive || !actions.showSend) setSendHover(false);
    }, [actions.showSend, isLive]);

    useEffect(() => {
      onActionOverlayChange?.(isLive && sendHover);
    }, [isLive, onActionOverlayChange, sendHover]);

    useEffect(
      () => () => {
        onActionOverlayChange?.(false);
      },
      [onActionOverlayChange],
    );

    const submit = (alternate = false) => {
      if (!canSubmit) return;
      void onSubmit(
        resolveSessionPromptMode({
          isLive,
          liveEnterBehavior,
          alternate,
        }),
      );
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (onBeforeKeyDown?.(event)) return;
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      submit(event.metaKey || event.ctrlKey);
    };

    const setTextareaRef = useCallback(
      (node: HTMLTextAreaElement | null) => {
        textareaRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    return (
      <div
        className={`relative z-10 rounded-2xl border bg-droid-elevated transition-colors ${cardClassName}`}
        style={cardStyle}
      >
        {context}
        <textarea
          ref={setTextareaRef}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value, event.currentTarget);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => {
            onSelectionChange?.(event.currentTarget);
          }}
          onClick={(event) => {
            onSelectionChange?.(event.currentTarget);
          }}
          onSelect={(event) => {
            onSelectionChange?.(event.currentTarget);
          }}
          onPaste={onPaste}
          placeholder={placeholder}
          rows={1}
          className="min-h-[44px] max-h-[200px] w-full resize-none bg-transparent px-4 pb-2 pt-3 text-sm leading-relaxed text-droid-text placeholder:text-droid-text-muted/50 focus:outline-none"
        />

        <div className="space-y-1.5 border-t border-droid-border px-3 py-2.5">
          {toolbarTop && <div className="flex flex-wrap items-center gap-1.5">{toolbarTop}</div>}
          <div className="flex min-w-0 items-center gap-2">
            {toolbarLeading && (
              <div className="flex min-w-0 items-center gap-2">{toolbarLeading}</div>
            )}
            <div className="min-w-0 flex-1" />
            {toolbarTrailing}
            <div className="flex shrink-0 items-center gap-1">
              {actions.showStop && onStop && (
                <button
                  type="button"
                  onClick={onStop}
                  title="Working — click to stop"
                  aria-label="Stop current turn"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-droid-accent text-droid-bg transition-opacity hover:opacity-90"
                >
                  <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />
                </button>
              )}
              {actions.showSend && (
                <div
                  className="relative shrink-0"
                  onMouseEnter={() => {
                    setSendHover(true);
                  }}
                  onMouseLeave={() => {
                    setSendHover(false);
                  }}
                >
                  <AnimatePresence>
                    {isLive && sendHover && (
                      <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 4 }}
                        transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                        className="absolute bottom-full right-0 z-50 mb-2 flex flex-col gap-0.5 rounded-xl border border-droid-border bg-droid-elevated p-1.5 shadow-2xl shadow-black/40"
                      >
                        {[
                          { label: enterSteers ? 'Steer' : 'Queue', keys: ['⏎'] },
                          { label: enterSteers ? 'Queue' : 'Steer', keys: ['⌘', '⏎'] },
                        ].map((row) => (
                          <div
                            key={row.label}
                            className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 text-[12px] text-droid-text"
                          >
                            <span>{row.label}</span>
                            <span className="flex items-center gap-0.5 rounded-md bg-droid-bg/70 px-1.5 py-0.5 text-[11px] text-droid-text-secondary">
                              {row.keys.map((key) => (
                                <kbd key={key} className="font-sans leading-none">
                                  {key}
                                </kbd>
                              ))}
                            </span>
                          </div>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <button
                    type="button"
                    onClick={() => {
                      submit();
                    }}
                    disabled={!canSubmit}
                    title={isLive ? undefined : idleSendTitle}
                    aria-label={sendAriaLabel}
                    className="flex h-8 w-8 items-center justify-center rounded-xl bg-droid-text text-droid-bg transition-colors hover:bg-droid-text-secondary disabled:cursor-not-allowed disabled:opacity-20"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  },
);

export default SessionComposer;
