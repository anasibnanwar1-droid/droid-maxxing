import { useState } from 'react';
import { Blocks, MessageSquare, Palette } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import type { MissionSummary } from '../../types/bridge';
import { interruptMission } from '../../lib/commands';
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

const TABS: { id: StudioLeftTab; label: string; icon: typeof MessageSquare }[] = [
  { id: 'agent', label: 'Agent', icon: MessageSquare },
  { id: 'components', label: 'Components', icon: Blocks },
  { id: 'libraries', label: 'Libraries', icon: Palette },
];

export default function AgentPanel({
  cwd,
  sessionKey,
}: {
  cwd: string;
  /** Stable project key for design.sessions (live path). */
  sessionKey: string;
}) {
  const { state } = useStore();
  const { studio, studioDispatch } = useStudioCanvas();
  const [text, setText] = useState('');
  const tab = studio.leftTab;
  const { sessionId, transcript, send, setModel, modelId, reasoningEffort } = useDesignSession(
    cwd,
    sessionKey,
  );
  // Record index can miss at runtime even though the type says otherwise.
  const mission = sessionId ? (state.missions[sessionId] as MissionSummary | undefined) : undefined;
  const streaming = !!mission?.streaming;

  const handleSubmit = (instruction: string, opts: SendOptions) => {
    send(instruction, opts.modelId, opts.reasoningEffort);
  };

  return (
    <div className="flex h-full w-[336px] shrink-0 flex-col border-r border-droid-border bg-droid-surface">
      <div data-electron-drag-region className="h-11 shrink-0" />

      <div className="flex items-center gap-0.5 px-3 pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              studioDispatch({ type: 'SET_LEFT_TAB', tab: t.id });
            }}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] transition-colors ${
              tab === t.id
                ? 'bg-droid-elevated text-droid-text'
                : 'text-droid-text-muted hover:text-droid-text-secondary'
            }`}
          >
            <t.icon className="h-3.5 w-3.5" />
            {t.label}
          </button>
        ))}
        {/* Icon-only history next to Libraries so earlier threads are obvious. */}
        <div className="ml-auto">
          <ThreadHistoryMenu cwd={cwd} sessionKey={sessionKey} variant="tab" />
        </div>
      </div>

      {tab === 'agent' && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {sessionId ? (
              transcript.length === 0 && !state.historyLoaded[sessionId] ? (
                <ThreadSkeleton />
              ) : (
                <div className="px-4 py-4">
                  {/* Same feed as the main chat — tool cards, thinking, diffs, streaming. */}
                  <MessageFeed events={transcript} pending={streaming} />
                </div>
              )
            ) : (
              <ThreadBody messages={[]} onPickSuggestion={setText} />
            )}
          </div>
          {state.pendingQuestion?.missionId === sessionId && <AskUserModal inline />}
          <StudioComposer
            text={text}
            onTextChange={setText}
            onSend={handleSubmit}
            streaming={streaming}
            onStop={() => {
              if (sessionId) interruptMission(sessionId);
            }}
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
          <DnaShelf cwd={cwd} sessionKey={sessionKey} />
        </div>
      )}
    </div>
  );
}
