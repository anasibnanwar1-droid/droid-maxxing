import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { gitCommit } from '../../lib/git';
import { toast } from '../../lib/toast';
import { useBusyAction } from '../../hooks/useBusyAction';

// Inline commit form shown beneath the git actions row.
export function CommitSheet({ cwd, onDone }: { cwd: string; onDone: () => void }) {
  const [message, setMessage] = useState('');
  const [stageAll, setStageAll] = useState(true);
  // run() guards against a second Cmd/Ctrl+Enter (the button is disabled,
  // but the keyboard shortcut isn't) firing a duplicate in-flight commit.
  const { busy, run } = useBusyAction();

  const doCommit = () =>
    run(async () => {
      const text = message.trim();
      if (!text) return;
      try {
        const res = await gitCommit(cwd, { message: text, all: stageAll });
        if (res.ok) {
          toast.success(`Committed ${res.head ?? ''}`.trim());
          setMessage('');
          onDone();
        } else if (res.reason === 'nothing_to_commit') {
          toast.info('Nothing to commit');
        } else {
          toast.error(res.message || 'Commit failed');
        }
      } catch {
        // A rejected IPC call (transport failure, no bridge) would otherwise leave
        // the user with only a cleared spinner and no feedback.
        toast.error('Commit failed');
      }
    });

  return (
    <div className="mx-2 mb-1.5 space-y-2 rounded-xl bg-droid-elevated/50 px-2.5 py-2.5">
      <textarea
        autoFocus
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void doCommit();
        }}
        rows={3}
        placeholder="Commit message"
        className="w-full resize-none rounded-lg bg-droid-bg/60 px-2.5 py-2 text-[12.5px] text-droid-text placeholder:text-droid-text-muted/70 focus:outline-none"
      />
      <div className="flex items-center justify-between">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-droid-text-secondary">
          <input
            type="checkbox"
            checked={stageAll}
            onChange={(e) => setStageAll(e.target.checked)}
            className="accent-droid-accent"
          />
          Stage all changes
        </label>
        <button
          onClick={() => void doCommit()}
          disabled={!message.trim() || busy}
          className="flex items-center gap-1.5 rounded-lg bg-droid-accent/15 px-2.5 py-1 text-[11.5px] font-medium text-droid-accent transition-colors hover:bg-droid-accent/25 disabled:opacity-40"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          Commit
        </button>
      </div>
    </div>
  );
}
