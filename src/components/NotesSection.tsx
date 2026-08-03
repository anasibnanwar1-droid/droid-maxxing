import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, X } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import { NotesIntroCard } from './NotesIntroCard';
import { INTRO_WIDTH, notesIntroPosition } from '../lib/notesIntro';
import {
  NOTE_TAG_CHIP,
  NOTE_TAG_HINT,
  composeNoteText,
  exactNoteTag,
  noteTagMenu,
  noteTextWithoutTag,
  parseNoteTag,
  type NoteTag,
} from '../lib/notesTags';
import { dismissNotesIntro, loadNotesIntroSeen, type SessionNote } from '../lib/sessionNotes';

const EASE = [0.16, 1, 0.3, 1] as const;

// Scratch notes for the active session: write a thought down in the notepad
// box, it stacks as a checklist line, and clicking a line hands the text to
// the composer so it can be sent as a prompt. The bullet fills once a note has
// been sent. Notes persist per session across restarts.
export default function NotesSection({ appSessionId }: { appSessionId: string }) {
  const { state, dispatch } = useStore();
  const notes = state.sessionNotes[appSessionId] ?? [];
  const [draft, setDraft] = useState('');
  // Tag chipped in the pad via the @ menu; save folds it into the note text.
  const [tag, setTag] = useState<NoteTag | null>(null);
  // One-time "what's new" spotlight for the feature, per profile.
  const [introVisible, setIntroVisible] = useState(() => !loadNotesIntroSeen());

  const save = () => {
    if (!draft.trim()) return;
    dispatch({ type: 'SESSION_NOTE_ADD', appSessionId, text: composeNoteText(tag, draft) });
    setDraft('');
    setTag(null);
  };

  const dismissIntro = () => {
    setIntroVisible(false);
    dismissNotesIntro();
  };

  return (
    <NotesPanel
      notes={notes}
      draft={draft}
      onDraftChange={setDraft}
      onSave={save}
      onUse={(note) => {
        dispatch({ type: 'SEED_COMPOSER', text: note.text });
        dispatch({ type: 'SESSION_NOTE_MARK_USED', appSessionId, noteId: note.id });
      }}
      onRemove={(noteId) => {
        dispatch({ type: 'SESSION_NOTE_REMOVE', appSessionId, noteId });
      }}
      introVisible={introVisible}
      onDismissIntro={dismissIntro}
      tag={tag}
      onTagSelect={(next) => {
        setTag(next);
        setDraft('');
      }}
      onTagClear={() => {
        setTag(null);
      }}
    />
  );
}

// Small ring in the header showing how many stacked notes have been sent,
// like the progress ring on a checklist card.
function ProgressRing({ used, total }: { used: number; total: number }) {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const fraction = total > 0 ? used / total : 0;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="shrink-0 -rotate-90">
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        className="stroke-droid-border"
        strokeWidth="2.5"
      />
      {fraction > 0 && (
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          className="stroke-droid-accent"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          style={{ transition: 'stroke-dashoffset 300ms ease' }}
        />
      )}
    </svg>
  );
}

// Presentational half, kept pure so the layout can be tested without a store.
export function NotesPanel({
  notes,
  draft,
  onDraftChange,
  onSave,
  onUse,
  onRemove,
  introVisible,
  onDismissIntro,
  tag,
  onTagSelect,
  onTagClear,
}: {
  notes: SessionNote[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onUse: (note: SessionNote) => void;
  onRemove: (noteId: string) => void;
  introVisible: boolean;
  onDismissIntro: () => void;
  tag: NoteTag | null;
  onTagSelect: (tag: NoteTag) => void;
  onTagClear: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const used = notes.filter((note) => note.usedAt !== null).length;

  // Pad @ autocomplete: while the whole draft is just a @token, the menu lists
  // matching tags; picking one chips it in the pad. Index and suppression are
  // pure UI state; the chip itself is controlled by the wrapper above.
  const [tagMenuIndex, setTagMenuIndex] = useState(0);
  const [tagMenuSuppressed, setTagMenuSuppressed] = useState(false);
  const { query: tagQuery, matching: matchingTags } = noteTagMenu(draft, tag);
  const tagMenuOpen = !tagMenuSuppressed && matchingTags.length > 0;
  const activeTagIndex = Math.max(0, Math.min(tagMenuIndex, matchingTags.length - 1));

  const selectTag = (next: NoteTag) => {
    onTagSelect(next);
    setTagMenuIndex(0);
    setTagMenuSuppressed(false);
  };

  // After a tag chips in, land the caret in the pad for the body.
  const hadTag = useRef(tag !== null);
  useEffect(() => {
    const hasTag = tag !== null;
    if (hasTag && !hadTag.current) textareaRef.current?.focus();
    hadTag.current = hasTag;
  }, [tag]);

  // Track the Notes card's viewport position while the intro is up so the
  // floating card stays glued to it. The capture-phase scroll listener also
  // catches the panel's own scroll container, which does not bubble.
  useEffect(() => {
    if (!introVisible) return;
    const measure = () => {
      setAnchorRect(cardRef.current?.getBoundingClientRect() ?? null);
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [introVisible, open, notes.length]);

  // "Try it now" lands the caret in the pad; if the card is collapsed the pad
  // only mounts after it opens, so the focus waits for that render.
  const focusAfterOpen = useRef(false);
  const tryNotes = () => {
    onDismissIntro();
    if (open) {
      textareaRef.current?.focus();
      return;
    }
    focusAfterOpen.current = true;
    setOpen(true);
  };
  useEffect(() => {
    if (open && focusAfterOpen.current) {
      focusAfterOpen.current = false;
      textareaRef.current?.focus();
    }
  }, [open]);

  // The pad starts five lines tall so it reads as a place to write, then grows
  // with the text like the main composer, capped so a long note scrolls
  // instead of swallowing the panel. Reopen is a dep too: collapsing unmounts
  // the pad and drops its fitted height, so it must refit on the fresh mount.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight, 168))}px`;
  }, [draft, open]);

  // anchorRect only exists client-side after measurement, so window is safe.
  const introPos = anchorRect ? notesIntroPosition(anchorRect, window.innerHeight) : null;

  return (
    <div>
      <div
        ref={cardRef}
        className="mx-3 mb-2 mt-1 rounded-2xl border border-droid-border bg-droid-elevated/40 shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
      >
        <button
          type="button"
          onClick={() => {
            setOpen(!open);
          }}
          className="flex w-full items-center gap-2.5 px-3.5 pb-1.5 pt-3 text-left"
        >
          <ProgressRing used={used} total={notes.length} />
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold text-droid-text">Notes</span>
            <span className="block text-[11px] text-droid-text-muted">
              {notes.length > 0
                ? `${String(used)}/${String(notes.length)} sent`
                : 'Scratch pad for this session'}
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-droid-text-muted transition-transform duration-200 ${
              open ? '' : '-rotate-90'
            }`}
          />
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="overflow-hidden"
            >
              <div className="px-2.5 pb-2.5">
                {/* Notepad box: intentionally plain — Enter saves, no send chrome.
                    Uses the field token: raised like the composer on dark, crisp
                    card-surface on light. */}
                <div>
                  <div className="rounded-lg border border-droid-border/60 bg-droid-field px-2.5 py-1.5 transition-colors focus-within:border-droid-accent/40">
                    {tag && (
                      <div className="mb-1 flex">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${NOTE_TAG_CHIP[tag]}`}
                        >
                          {tag}
                          <button
                            type="button"
                            aria-label="Remove tag"
                            onClick={onTagClear}
                            className="rounded-sm opacity-70 transition-opacity hover:opacity-100"
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      </div>
                    )}
                    <textarea
                      ref={textareaRef}
                      value={draft}
                      onChange={(event) => {
                        onDraftChange(event.target.value);
                        setTagMenuIndex(0);
                        setTagMenuSuppressed(false);
                      }}
                      onKeyDown={(event) => {
                        if (tagMenuOpen) {
                          if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setTagMenuIndex((activeTagIndex + 1) % matchingTags.length);
                            return;
                          }
                          if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setTagMenuIndex(
                              (activeTagIndex + matchingTags.length - 1) % matchingTags.length,
                            );
                            return;
                          }
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            // The menu is only open with matches, and the index
                            // is clamped into range, so this always exists.
                            selectTag(matchingTags[activeTagIndex]);
                            return;
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            setTagMenuSuppressed(true);
                            return;
                          }
                          // Typing the tag out and hitting Space chips it too,
                          // so the menu is a shortcut, not a requirement.
                          if (event.key === ' ') {
                            const exact = exactNoteTag(tagQuery, matchingTags);
                            if (exact) {
                              event.preventDefault();
                              selectTag(exact);
                              return;
                            }
                          }
                        }
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          onSave();
                          return;
                        }
                        if (event.key === 'Backspace' && draft === '' && tag !== null) {
                          onTagClear();
                        }
                      }}
                      placeholder={
                        tag
                          ? 'Add the detail — Enter to save'
                          : 'Write a note to use later — Enter to save'
                      }
                      rows={5}
                      className="w-full resize-none bg-transparent text-[12.5px] leading-snug text-droid-text placeholder:text-droid-text-muted/50 focus:outline-none"
                    />
                  </div>

                  {/* Tag menu in flow directly below the pad: as an absolute
                      overlay it was clipped by the collapse container's
                      overflow-hidden whenever the note list was shorter than
                      the menu (the empty first-run state). */}
                  <AnimatePresence>
                    {tagMenuOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.15, ease: EASE }}
                        className="mt-1.5 overflow-hidden rounded-xl border border-droid-border bg-droid-elevated py-1 shadow-2xl shadow-black/40"
                      >
                        {matchingTags.map((option, index) => (
                          <button
                            key={option}
                            type="button"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              selectTag(option);
                            }}
                            onMouseEnter={() => {
                              setTagMenuIndex(index);
                            }}
                            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
                              index === activeTagIndex ? 'bg-droid-hover/60' : ''
                            }`}
                          >
                            <span
                              className={`px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide ${NOTE_TAG_CHIP[option]}`}
                            >
                              {option}
                            </span>
                            <span className="text-[11.5px] text-droid-text-muted">
                              {NOTE_TAG_HINT[option]}
                            </span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="mt-1">
                  <AnimatePresence initial={false}>
                    {notes.map((note) => {
                      const tag = parseNoteTag(note.text);
                      return (
                        <motion.div
                          key={note.id}
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.22, ease: EASE }}
                          className="group relative overflow-hidden"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              onUse(note);
                            }}
                            title="Send to composer"
                            className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-droid-hover/60 focus-visible:bg-droid-hover/60 focus-visible:outline-none"
                          >
                            <span
                              aria-hidden
                              className={`mt-[3px] h-[13px] w-[13px] shrink-0 rounded-full border-[1.5px] transition-colors duration-300 ${
                                note.usedAt !== null
                                  ? 'border-droid-accent bg-droid-accent'
                                  : 'border-droid-text-muted/40 group-hover:border-droid-text-muted/70'
                              }`}
                            />
                            <span
                              className={`line-clamp-2 min-w-0 flex-1 break-words pr-4 text-[12.5px] leading-snug transition-colors ${
                                note.usedAt !== null
                                  ? 'text-droid-text-muted'
                                  : 'text-droid-text-secondary group-hover:text-droid-text'
                              }`}
                            >
                              {tag && (
                                <span
                                  className={`mr-1.5 px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide ${NOTE_TAG_CHIP[tag]}`}
                                >
                                  {tag}
                                </span>
                              )}
                              {tag ? noteTextWithoutTag(note.text) : note.text}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onRemove(note.id);
                            }}
                            title="Delete note"
                            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-droid-text-muted opacity-0 transition-opacity hover:bg-droid-active hover:text-droid-text focus-visible:opacity-100 group-hover:opacity-100"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>

                  {notes.length === 0 && (
                    <div className="px-2 py-1.5 text-[11.5px] leading-snug text-droid-text-muted">
                      No notes yet. Click a saved note to send it as a prompt — start it with @bug,
                      @next, @idea or @constraint to tag it.
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Floating intro, portaled out so the panel's scroll box can't clip it.
          Server renders have no document, so static markup stays anchor-only. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {introVisible && introPos && (
              <NotesIntroCard
                style={{
                  position: 'fixed',
                  top: introPos.top,
                  left: introPos.left,
                  width: INTRO_WIDTH,
                }}
                caretTop={introPos.caretTop}
                onTry={tryNotes}
                onClose={onDismissIntro}
              />
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}
