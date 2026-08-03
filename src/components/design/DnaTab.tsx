import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, GitCommitHorizontal, ScanSearch, Sparkles, X } from 'lucide-react';
import { useDesignStore } from '../../hooks/useDesignStore';
import {
  applyDnaLibrary,
  commitDesignChange,
  scanDesignDna,
  writeDesignDna,
} from '../../lib/commands';
import type { DnaFileState } from '../../types/bridge';

const inputClass =
  'h-8 min-w-0 rounded-md border border-droid-border bg-droid-bg/60 px-2.5 text-[12.5px] text-droid-text placeholder:text-droid-text-muted/50 outline-none focus:border-droid-accent';

const chipClass = 'bg-droid-elevated rounded px-1.5 py-0.5 text-[10.5px] font-mono text-droid-text';

type FileKey = 'design' | 'motion';

interface EditorState {
  value: string;
  seeded: string;
}

export default function DnaTab({
  cwd,
  appSessionId,
}: {
  cwd: string;
  appSessionId: string | null;
}) {
  void appSessionId;
  const { design, designDispatch } = useDesignStore();
  const dna = design.dna[cwd];
  const draft = design.drafts[cwd];
  const gitResult = design.gitResults[cwd];

  const [editors, setEditors] = useState<Record<FileKey, EditorState>>({
    design: { value: '', seeded: '' },
    motion: { value: '', seeded: '' },
  });
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [draftHidden, setDraftHidden] = useState(false);
  const [confirmLibrary, setConfirmLibrary] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('design: update design DNA');

  // Seed editors when the DNA state for this cwd arrives, and re-seed on fresh
  // content only if the editor has no local edits.
  useEffect(() => {
    if (!dna) return;
    setEditors((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of ['design', 'motion'] as FileKey[]) {
        const incoming = dna[key].content;
        const editor = prev[key];
        const freshCwd = seededFor !== cwd;
        const clean = editor.value === editor.seeded;
        if (freshCwd || (clean && incoming !== editor.seeded)) {
          next[key] = { value: incoming, seeded: incoming };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    if (seededFor !== cwd) setSeededFor(cwd);
  }, [dna, cwd, seededFor]);

  useEffect(() => {
    setDraftHidden(false);
    setConfirmLibrary(null);
  }, [cwd]);

  const setEditorValue = (key: FileKey, value: string) =>
    setEditors((prev) => ({ ...prev, [key]: { ...prev[key], value } }));

  const save = (key: FileKey) => {
    const value = editors[key].value;
    writeDesignDna(cwd, key, value);
    setEditors((prev) => ({ ...prev, [key]: { value, seeded: value } }));
  };

  const useDraft = () => {
    if (!draft) return;
    setEditors((prev) => ({
      ...prev,
      design: { ...prev.design, value: draft.content },
    }));
    setDraftHidden(true);
  };

  const tokens = dna?.tokens;

  return (
    <div className="max-w-3xl space-y-5">
      <header>
        <h2 className="text-[15px] font-semibold text-droid-text">Design DNA</h2>
        <p className="mt-1 text-[12px] text-droid-text-muted">
          DESIGN.md and MOTION.md define the project's visual contract. They are injected into
          design prompts and exposed to agents via MCP.
        </p>
      </header>

      {tokens && (
        <section className="rounded-xl border border-droid-border bg-droid-surface p-4 space-y-3">
          <div className="text-[12.5px] font-medium text-droid-text">Tokens</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(tokens.colors).map(([name, hex]) => (
              <div key={name} className="flex items-center gap-1.5" title={name}>
                <span
                  className="w-5 h-5 rounded border border-droid-border"
                  style={{ backgroundColor: hex }}
                />
                <span className="text-[10.5px] font-mono text-droid-text-muted">{hex}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(tokens.fonts).map(
              ([role, font]) =>
                font && (
                  <span key={role} className={chipClass}>
                    {role}: {font}
                  </span>
                ),
            )}
          </div>
          <div className="space-y-1.5 text-[10.5px]">
            {(
              [
                ['type', tokens.typeScale],
                ['spacing', tokens.spacing],
                ['radii', tokens.radii],
              ] as const
            ).map(
              ([label, values]) =>
                values.length > 0 && (
                  <div key={label} className="flex flex-wrap items-center gap-1.5">
                    <span className="w-14 text-droid-text-muted">{label}</span>
                    {values.map((v, i) => (
                      <span key={i} className={chipClass}>
                        {v}
                      </span>
                    ))}
                  </div>
                ),
            )}
          </div>
        </section>
      )}

      {(['design', 'motion'] as FileKey[]).map((key) => (
        <FileEditor
          key={key}
          fileKey={key}
          file={dna?.[key]}
          editor={editors[key]}
          onChange={(value) => setEditorValue(key, value)}
          onSave={() => save(key)}
        />
      ))}

      <section className="rounded-xl border border-droid-border bg-droid-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium text-droid-text">Scan project</div>
            <div className="mt-0.5 text-[11px] text-droid-text-muted">
              Infers a DESIGN.md draft from the project's existing styles and config.
            </div>
          </div>
          <button
            onClick={() => {
              setDraftHidden(false);
              scanDesignDna(cwd);
            }}
            className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-droid-border text-[12.5px] text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
          >
            <ScanSearch className="w-3.5 h-3.5" />
            Scan project
          </button>
        </div>

        <AnimatePresence initial={false}>
          {draft && !draftHidden && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="mt-3 rounded-lg border border-droid-border bg-droid-bg/60 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="text-[12px] font-medium text-droid-text">Draft DESIGN.md</div>
                <button
                  onClick={() => setDraftHidden(true)}
                  className="p-1 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors"
                  title="Dismiss draft"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <pre className="mt-2 max-h-64 overflow-auto text-[11px] font-mono text-droid-text whitespace-pre-wrap">
                {draft.content}
              </pre>
              {draft.sources.length > 0 && (
                <div className="mt-2 text-[10.5px] text-droid-text-muted">
                  Sources: {draft.sources.join(', ')}
                </div>
              )}
              <button
                onClick={useDraft}
                className="mt-3 h-8 px-3.5 rounded-md bg-droid-accent text-white text-[12.5px] font-medium hover:opacity-90 transition-opacity"
              >
                Use as DESIGN.md
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {design.libraries.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-droid-text">
            <Sparkles className="w-3.5 h-3.5 text-droid-text-muted" />
            Curated libraries
          </div>
          <div className="grid grid-cols-2 gap-3">
            {design.libraries.map((lib) => (
              <div
                key={lib.id}
                className="rounded-xl border border-droid-border bg-droid-surface p-4"
              >
                <div className="text-[12.5px] font-medium text-droid-text">{lib.name}</div>
                <div className="mt-0.5 text-[11px] text-droid-text-muted">{lib.tagline}</div>
                <div className="mt-2.5 flex items-center gap-1.5">
                  {lib.colors.map((color, i) => (
                    <span
                      key={i}
                      className="w-4 h-4 rounded-full border border-droid-border"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
                <div className="mt-1.5 text-[10.5px] font-mono text-droid-text-muted">
                  {lib.fonts.join(' \u00b7 ')}
                </div>
                <div className="mt-3">
                  {confirmLibrary === lib.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-droid-text-muted">Replace DESIGN.md?</span>
                      <button
                        onClick={() => {
                          applyDnaLibrary(cwd, lib.id);
                          setConfirmLibrary(null);
                        }}
                        className="flex items-center gap-1 h-7 px-2.5 rounded-md bg-droid-accent text-white text-[11px] font-medium hover:opacity-90 transition-opacity"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmLibrary(null)}
                        className="h-7 px-2.5 rounded-md border border-droid-border text-[11px] text-droid-text-muted hover:text-droid-text transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmLibrary(lib.id)}
                      className="h-7 px-2.5 rounded-md border border-droid-border text-[11px] text-droid-text hover:bg-droid-elevated/60 transition-colors"
                    >
                      Apply
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-droid-border bg-droid-surface p-4 space-y-3">
        <div className="text-[12.5px] font-medium text-droid-text">Commit changes</div>
        <div className="flex items-center gap-2">
          <input
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Commit message"
            className={`${inputClass} flex-1`}
          />
          <button
            onClick={() => commitDesignChange(cwd, commitMessage)}
            disabled={!commitMessage.trim()}
            className="flex items-center gap-1.5 h-8 px-3.5 rounded-md bg-droid-accent text-white text-[12.5px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            <GitCommitHorizontal className="w-3.5 h-3.5" />
            Commit
          </button>
        </div>
        {gitResult && (
          <div
            className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[12px] ${
              gitResult.ok
                ? 'border border-green-500/30 bg-green-500/10 text-green-400'
                : 'border border-red-500/30 bg-red-500/10 text-red-400'
            }`}
          >
            <span className="min-w-0 truncate">
              {gitResult.ok
                ? `Committed ${gitResult.sha ? gitResult.sha.slice(0, 7) : ''}`.trim()
                : (gitResult.error ?? 'Commit failed')}
            </span>
            <button
              onClick={() => designDispatch({ type: 'CLEAR_GIT_RESULT', cwd })}
              className="shrink-0 hover:opacity-70 transition-opacity"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function FileEditor({
  fileKey,
  file,
  editor,
  onChange,
  onSave,
}: {
  fileKey: FileKey;
  file: DnaFileState | undefined;
  editor: EditorState;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const filename = fileKey === 'design' ? 'DESIGN.md' : 'MOTION.md';
  const dirty = editor.value !== editor.seeded;

  return (
    <section className="rounded-xl border border-droid-border bg-droid-surface p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-baseline gap-2">
          <span className="font-mono text-[12.5px] text-droid-text">{filename}</span>
          {file && (
            <span className="text-[10.5px] text-droid-text-muted truncate" title={file.path}>
              {file.path}
            </span>
          )}
          {file && !file.exists && (
            <span className="shrink-0 text-[10.5px] text-droid-text-muted/70">not created yet</span>
          )}
        </div>
        <button
          onClick={onSave}
          disabled={!dirty}
          className="h-8 px-3.5 rounded-md bg-droid-accent text-white text-[12.5px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          Save
        </button>
      </div>
      <textarea
        value={editor.value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder={`Write ${filename}\u2026`}
        className="w-full font-mono text-[12px] bg-droid-bg/60 border border-droid-border rounded-lg p-3 min-h-[220px] resize-y outline-none focus:border-droid-accent text-droid-text placeholder:text-droid-text-muted/50"
      />
    </section>
  );
}
