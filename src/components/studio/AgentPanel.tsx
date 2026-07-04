import { useState } from 'react';
import { Blocks, MessageSquare, Palette, Plus } from 'lucide-react';
import { useStudioCanvas, type StudioLeftTab } from './StudioCanvasContext';
import StudioComposer, { type SendOptions } from './StudioComposer';
import ThreadBody, { type ThreadMessage } from './ThreadBody';
import ComponentShelf from './ComponentShelf';
import DnaShelf from './DnaShelf';

const TABS: { id: StudioLeftTab; label: string; icon: typeof MessageSquare }[] = [
  { id: 'agent', label: 'Agent', icon: MessageSquare },
  { id: 'components', label: 'Components', icon: Blocks },
  { id: 'libraries', label: 'Libraries', icon: Palette },
];

let messageSeq = 0;
const nextMessageId = () => `msg_${++messageSeq}`;

export default function AgentPanel({
  cwd,
  onSubmit,
  disabledReason,
}: {
  cwd: string;
  onSubmit: (instruction: string, opts: SendOptions) => void;
  disabledReason?: string;
}) {
  const { studio, studioDispatch } = useStudioCanvas();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [text, setText] = useState('');
  const tab = studio.leftTab;

  const handleSubmit = (instruction: string, opts: SendOptions) => {
    // M1 stages the brief on the thread; live agent turns stream in once
    // generation is wired (M4). No fabricated "working…" echo.
    const user: ThreadMessage = {
      id: nextMessageId(),
      role: 'user',
      text: instruction,
      images: opts.images,
    };
    setMessages((prev) => [...prev, user]);
    onSubmit(instruction, opts);
  };

  return (
    <div className="flex h-full w-[336px] shrink-0 flex-col border-r border-droid-border bg-droid-surface">
      <div data-electron-drag-region className="h-11 shrink-0" />

      {/* Tabs */}
      <div className="flex items-center gap-0.5 px-3 pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => { studioDispatch({ type: 'SET_LEFT_TAB', tab: t.id }); }}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] transition-colors ${
              tab === t.id
                ? 'bg-white/[0.07] text-droid-text'
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
          <ThreadHeader onNew={() => { setMessages([]); }} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ThreadBody messages={messages} onPickSuggestion={setText} />
          </div>
          <StudioComposer
            text={text}
            onTextChange={setText}
            onSend={handleSubmit}
            disabledReason={disabledReason}
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

function ThreadHeader({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 pb-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[12.5px] font-medium text-droid-text">Untitled thread</span>
      </div>
      <button
        onClick={onNew}
        title="New thread"
        className="flex h-6 w-6 items-center justify-center rounded-md text-droid-text-muted transition-colors hover:bg-white/[0.06] hover:text-droid-text"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
