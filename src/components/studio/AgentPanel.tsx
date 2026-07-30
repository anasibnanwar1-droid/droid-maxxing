import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import type { SessionSummary } from '../../types/bridge';
import { interruptSession } from '../../lib/commands';
import { isDesktop } from '../../lib/desktop';
import { sessionIsLive } from '../../lib/sessions';
import AskUserModal from '../AskUserModal';
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
      imageDataUrl: image.src,
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

      <nav className="flex h-10 shrink-0 items-center gap-1 border-b border-droid-border px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              studioDispatch({ type: 'SET_LEFT_TAB', tab: t.id });
            }}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`rounded-lg px-3 py-1.5 text-[12px] transition-colors duration-150 ${
              tab === t.id
                ? 'bg-droid-active text-droid-text'
                : 'text-droid-text-muted hover:bg-droid-elevated/60 hover:text-droid-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

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
          {state.pendingQuestion?.appSessionId === sessionId && <AskUserModal inline />}
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
            send={(instruction) => {
              send(instruction);
            }}
          />
        </div>
      )}
    </aside>
  );
}
