import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, FileDiff, Check } from 'lucide-react';
import { listEditors, notify, openProject } from '../lib/desktop';
import { toast } from '../lib/toast';
import { EditorIcon } from './EditorIcon';
import { EDITOR_OPTIONS, editorLabel, getDefaultEditor, setDefaultEditor, type EditorId, type EditorTarget } from '../lib/editorOpen';

const TARGET_LABEL: Record<EditorTarget, string> = { codebase: 'codebase', diff: 'current diff' };

async function launch(cwd: string, editor: EditorId, target: EditorTarget) {
  try {
    await openProject(cwd, editor, target);
    toast.success(`Opened ${TARGET_LABEL[target]} in ${editorLabel(editor)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    toast.error(`Could not open ${editorLabel(editor)}`);
    await notify('Could not open editor', message);
  }
}

export function openCodebase(cwd: string) {
  if (!cwd) return;
  void launch(cwd, getDefaultEditor(), 'codebase');
}

export function openCurrentDiff(cwd: string) {
  if (!cwd) return;
  void launch(cwd, getDefaultEditor(), 'diff');
}

export default function EditorOpenMenu({
  cwd,
  hasRepo = true,
  variant = 'panel',
}: {
  cwd: string;
  hasRepo?: boolean;
  variant?: 'panel' | 'toolbar';
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<EditorId>(() => getDefaultEditor());
  const [installed, setInstalled] = useState<EditorId[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const hasCwd = Boolean(cwd);

  // Only offer editors that are actually present on this machine. If detection
  // returns nothing (e.g. running in a browser), fall back to the full list.
  const options = installed.length > 0 ? EDITOR_OPTIONS.filter((o) => installed.includes(o.id)) : EDITOR_OPTIONS;

  useEffect(() => {
    let cancelled = false;
    listEditors().then((found) => {
      if (cancelled || found.length === 0) return;
      setInstalled(found);
      // If the saved default isn't installed, fall back to the first available
      // one so the main button always opens something that exists.
      if (!found.includes(getDefaultEditor())) {
        setDefaultEditor(found[0]);
        setSelected(found[0]);
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (target: EditorTarget) => {
    setOpen(false);
    if (!hasCwd) return;
    void launch(cwd, selected, target);
  };

  // Picking a default editor only changes the preference — it never launches,
  // so the menu stays open and the user can then choose an explicit action.
  const chooseDefault = (editor: EditorId) => {
    setDefaultEditor(editor);
    setSelected(editor);
  };

  return (
    <div className="relative" ref={ref}>
      {variant === 'toolbar' ? (
        <div className="flex items-center rounded-md overflow-hidden">
          <button
            onClick={() => hasCwd && openCodebase(cwd)}
            disabled={!hasCwd}
            title={hasCwd ? `Open codebase with ${editorLabel(selected)}` : 'No folder for this session'}
            className="flex items-center pl-1.5 pr-1 py-1.5 text-droid-text-muted/80 hover:text-droid-text hover:bg-droid-elevated/60 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <EditorIcon editor={selected} size={15} />
          </button>
          <button
            onClick={() => setOpen((v) => !v)}
            title="Editor actions"
            className={`flex items-center pr-1.5 pl-0.5 py-1.5 transition-colors ${
              open ? 'text-droid-text bg-droid-elevated' : 'text-droid-text-muted/80 hover:text-droid-text hover:bg-droid-elevated/60'
            }`}
          >
            <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          title={`Open with ${editorLabel(selected)}`}
          className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11.5px] transition-colors ${
            open ? 'text-droid-text bg-droid-elevated' : 'text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60'
          }`}
        >
          <EditorIcon editor={selected} size={14} />
          <span className="max-w-[72px] truncate">{editorLabel(selected)}</span>
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-52 rounded-xl border border-droid-border bg-droid-surface p-1.5 shadow-2xl shadow-black/50">
          <MenuAction icon={<FolderOpen className="w-3.5 h-3.5" />} label="Open codebase" disabled={!hasCwd} onClick={() => run('codebase')} />
          <MenuAction
            icon={<FileDiff className="w-3.5 h-3.5" />}
            label="Open current diff"
            disabled={!hasCwd || !hasRepo}
            hint={!hasRepo && hasCwd ? 'No repo' : undefined}
            onClick={() => run('diff')}
          />

          <div className="my-1.5 h-px bg-droid-border/70" />
          <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">Default editor</div>

          {options.map((option) => (
            <button
              key={option.id}
              onClick={() => chooseDefault(option.id)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text-secondary hover:bg-droid-elevated/60 hover:text-droid-text transition-colors"
            >
              <EditorIcon editor={option.id} size={15} />
              <span className="flex-1 truncate">{option.label}</span>
              {selected === option.id && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--droid-accent)' }} strokeWidth={3} />}
            </button>
          ))}

          {!hasCwd && (
            <div className="mt-1 px-2 py-1.5 text-[11px] text-droid-text-muted">This session has no folder yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuAction({
  icon, label, hint, disabled, onClick,
}: {
  icon: React.ReactNode; label: string; hint?: string; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] text-droid-text transition-colors hover:bg-droid-elevated/60 disabled:cursor-not-allowed disabled:text-droid-text-muted/60 disabled:hover:bg-transparent"
    >
      <span className="shrink-0 text-droid-text-muted">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-[10px] text-droid-text-muted">{hint}</span>}
    </button>
  );
}
