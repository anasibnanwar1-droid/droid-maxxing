import { useState } from 'react';
import { Settings } from 'lucide-react';
import { notify, openProject } from '../lib/desktop';
import { EDITOR_OPTIONS, editorLabel, getDefaultEditor, setDefaultEditor, type EditorId } from '../lib/editorOpen';

export function openCodebase(cwd: string) {
  if (!cwd) return;
  void openOrNotify(cwd, getDefaultEditor(), 'codebase');
}

export function openCurrentDiff(cwd: string) {
  if (!cwd) return;
  void openOrNotify(cwd, getDefaultEditor(), 'diff');
}

async function openOrNotify(cwd: string, editor: EditorId, target: 'codebase' | 'diff') {
  try {
    await openProject(cwd, editor, target);
  } catch (err) {
    await notify('Could not open editor', err instanceof Error ? err.message : String(err));
  }
}

export default function EditorOpenMenu({ cwd }: { cwd: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<EditorId>(() => getDefaultEditor());

  const select = (editor: EditorId) => {
    setDefaultEditor(editor);
    setSelected(editor);
    setOpen(false);
    if (cwd) void openOrNotify(cwd, editor, 'codebase');
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        title={`Open with ${editorLabel(selected)}`}
        className="p-1 rounded-md text-droid-text-muted/60 hover:text-droid-text hover:bg-droid-elevated/60 transition-colors"
      >
        <Settings className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-50 w-40 rounded-xl border border-droid-border bg-droid-surface p-1 shadow-xl shadow-black/40">
          {EDITOR_OPTIONS.map((option) => (
            <button
              key={option.id}
              onClick={() => select(option.id)}
              className="w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] text-droid-text-secondary hover:bg-droid-elevated/60 hover:text-droid-text"
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
