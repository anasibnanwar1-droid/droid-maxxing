import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import type { SessionSummary } from '../../types/bridge';
import { interruptSession } from '../../lib/commands';
import { isDesktop } from '../../lib/desktop';
import { sessionIsLive } from '../../lib/sessions';
import { useStudioCanvas, type StudioLeftTab } from './StudioCanvasContext';
import { useDesignSession } from './useDesignSession';
import StudioComposer, { type SendOptions } from './StudioComposer';
import ThreadBody from './ThreadBody';
import { MessageFeed } from '../chat';
import ComponentShelf from './ComponentShelf';
import DnaShelf from './DnaShelf';
import ThreadHistoryMenu from './ThreadHistoryMenu';
import ThreadSkeleton from './ThreadSkeleton';

const TABS: { id: StudioLeftTab; label: string }[] = [
  { id: 'agent', label: 'Agent' },
  { id: 'components', label: 'Components' },
  { id: 'libraries', label: 'Libraries' },
];

export default function AgentPanel({
  cwd,
  sessionKey,
  onBack,
}: {
  cwd: string;
  /** Stable project key for design.sessions (live path). */
  sessionKey: string;
  onBack: () => void;
}) {
  const shouldReduceMotion = useReducedMotion();
  const { state } = useStore();
  const { studio, studioDispatch } = useStudioCanvas();
  const [text, setText] = useState('');
  const tab = studio.leftTab;
  const { sessionId, transcript, isCreating, send, setModel, modelId, reasoningEffort } =
    useDesignSession(cwd, sessionKey);
  // Record index can miss at runtime even though the type says otherwise.
  const session = sessionId ? (state.sessions[sessionId] as SessionSummary | undefined) : undefined;
  const streaming = session ? sessionIsLive(session) : false;
  const hasMacTrafficLights =
    isDesktop() && typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh');

  const handleSubmit = (instruction: string, opts: SendOptions) => {
    const prompt =
      opts.count > 1
        ? `${instruction}\n\nCreate ${String(opts.count)} clearly distinct design directions.`
        : instruction;
    const imageRefs = opts.canvasImages?.map((image) => ({
      id: image.libraryId,
      label: image.name,
      kind: 'region' as const,
      url: `droidex://canvas/${image.libraryId}`,
      ...(image.src.startsWith('data:image/') ? { imageDataUrl: image.src } : {}),
    }));
    send(prompt, {
      modelId: opts.modelId,
      reasoningEffort: opts.reasoningEffort,
      displayText: opts.displayText,
      browserRefs: imageRefs,
      mode: opts.mode,
    });
  };

  return (
    <aside
      className="flex h-full w-[352px] shrink-0 flex-col border-r border-droid-border"
      style={{
        background: 'var(--sidebar-bg)',
        backdropFilter: 'var(--sidebar-blur)',
        WebkitBackdropFilter: 'var(--sidebar-blur)',
      }}
    >
      <header
        data-electron-drag-region
        className={`flex h-[52px] shrink-0 items-center gap-2.5 border-b border-droid-border pr-3 ${
          hasMacTrafficLights ? 'pl-[82px]' : 'pl-3'
        }`}
      >
        <button
          type="button"
          onClick={onBack}
          title="Back to DROIDEX"
          aria-label="Back to DROIDEX"
          className="no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <div className="min-w-0 flex-1 truncate text-[12.5px] font-medium tracking-[0.04em] text-droid-text">
          DROIDEX DESIGN
        </div>
        <div className="no-drag">
          <ThreadHistoryMenu cwd={cwd} sessionKey={sessionKey} variant="tab" />
        </div>
      </header>

      <nav className="shrink-0 border-b border-droid-border px-3 pb-2.5 pt-1.5">
        <div className="relative flex rounded-lg bg-droid-elevated/50 p-0.5">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => {
                  studioDispatch({ type: 'SET_LEFT_TAB', tab: t.id });
                }}
                aria-current={active ? 'page' : undefined}
                className={`relative flex-1 rounded-md px-3 py-1.5 text-[12px] transition-colors duration-150 ${
                  active ? 'text-droid-text' : 'text-droid-text-muted hover:text-droid-text'
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="studio-left-tab-indicator"
                    transition={
                      shouldReduceMotion
                        ? { duration: 0 }
                        : { type: 'spring', stiffness: 520, damping: 42 }
                    }
                    className="absolute inset-0 rounded-md bg-droid-active shadow-sm ring-1 ring-droid-border/60"
                  />
                )}
                <span className="relative">{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <motion.div
        key={tab}
        initial={shouldReduceMotion ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={
          shouldReduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.16, 1, 0.3, 1] }
        }
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === 'agent' && (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {sessionId || isCreating ? (
                sessionId && transcript.length === 0 && !state.historyLoaded[sessionId] ? (
                  <ThreadSkeleton />
                ) : (
                  <div className="px-4 py-4">
                    {/* Same feed as the main chat — tool cards, thinking, diffs, streaming. */}
                    <MessageFeed events={transcript} pending={streaming || isCreating} />
                  </div>
                )
              ) : (
                <ThreadBody messages={[]} onPickSuggestion={setText} />
              )}
            </div>
            <StudioComposer
              key={sessionId ?? `new:${sessionKey}`}
              text={text}
              onTextChange={setText}
              onSend={handleSubmit}
              streaming={streaming}
              onStop={() => {
                if (sessionId) interruptSession(sessionId);
              }}
              sessionId={sessionId}
              disabledReason={isCreating ? 'Starting design session…' : undefined}
              hasSession={sessionId !== null}
              sessionModelId={modelId}
              sessionReasoning={reasoningEffort}
              onModelChange={setModel}
            />
          </>
        )}

        {tab === 'components' && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            <ComponentShelf cwd={cwd} />
          </div>
        )}

        {tab === 'libraries' && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            <DnaShelf
              cwd={cwd}
              sessionId={sessionId}
              streaming={streaming}
              send={(instruction, browserRefs) => {
                send(instruction, { browserRefs });
              }}
            />
          </div>
        )}
      </motion.div>
    </aside>
  );
}
