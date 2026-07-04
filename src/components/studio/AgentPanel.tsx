import { useState } from 'react';
import { Blocks, MessageSquare, Palette } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { interruptMission } from '../../lib/commands';
import AskUserModal from '../AskUserModal';
import { useStudioCanvas, type StudioLeftTab } from './StudioCanvasContext';
import { useDesignSession } from './useDesignSession';
import StudioComposer, { type SendOptions } from './StudioComposer';
import ThreadBody from './ThreadBody';
import SessionThread from './SessionThread';
import ComponentShelf from './ComponentShelf';
import DnaShelf from './DnaShelf';

const TABS: { id: StudioLeftTab; label: string; icon: typeof MessageSquare }[] = [
  { id: 'agent', label: 'Agent', icon: MessageSquare },
  { id: 'components', label: 'Components', icon: Blocks },
  { id: 'libraries', label: 'Libraries', icon: Palette },
];

export default function AgentPanel({ cwd }: { cwd: string }) {
  const { state } = useStore();
  const { studio, studioDispatch } = useStudioCanvas();
  const [text, setText] = useState('');
  const tab = studio.leftTab;
  const { sessionId, transcript, send } = useDesignSession(cwd);
  const streaming = !!(sessionId && state.missions[sessionId]?.streaming);

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
            onClick={() => studioDispatch({ type: 'SET_LEFT_TAB', tab: t.id })}
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
      </div>

      {tab === 'agent' && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {sessionId ? (
              <SessionThread events={transcript} streaming={streaming} />
            ) : (
              <ThreadBody messages={[]} onPickSuggestion={setText} />
            )}
          </div>
          {/* The agent's clarifying question, docked inline above the composer
              (not the full-screen global modal). */}
          {state.pendingQuestion?.missionId === sessionId && <AskUserModal inline />}
          <StudioComposer
            text={text}
            onTextChange={setText}
            onSend={handleSubmit}
            streaming={streaming}
            onStop={() => { if (sessionId) interruptMission(sessionId); }}
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
          <DnaShelf cwd={cwd} />
        </div>
      )}
    </div>
  );
}
