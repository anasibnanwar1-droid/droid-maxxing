import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, AtSign, ChevronDown, Copy, Gauge, ImagePlus, Square, X } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { useStudioCanvas } from './StudioCanvasContext';
import StudioModelPicker from './StudioModelPicker';
import { useImageAttachments } from './useImageAttachments';
import type { ReasoningEffort } from '../../types/bridge';

export interface SendOptions {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  count: number;
  images?: string[];
}

const COUNTS = [1, 2, 3, 4];

/** Coerce an effort to one the model supports (fall back to its default). */
function snapEffort(
  model:
    | { supportedReasoningEfforts?: ReasoningEffort[]; defaultReasoningEffort?: ReasoningEffort }
    | undefined,
  current: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  const supported = model?.supportedReasoningEfforts ?? [];
  if (supported.length === 0) return model?.defaultReasoningEffort;
  if (current && supported.includes(current)) return current;
  return model?.defaultReasoningEffort ?? supported[Math.min(supported.length - 1, 1)];
}

/** Compact host label for a frame chip, e.g. "localhost:5173". */
function frameHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The composer — the primary way to author designs. References resolved from the
 * canvas ride along as chips; the count selector is the fan-out control that
 * asks for N directions at once.
 */
export default function StudioComposer({
  text,
  onTextChange,
  onSend,
  disabledReason,
  streaming,
  onStop,
  sessionModelId,
  sessionReasoning,
  onModelChange,
}: {
  text: string;
  onTextChange: (value: string) => void;
  onSend: (instruction: string, opts: SendOptions) => void;
  disabledReason?: string;
  streaming?: boolean;
  onStop?: () => void;
  /** Live session model (when a design chat already exists). */
  sessionModelId?: string;
  sessionReasoning?: ReasoningEffort;
  /** Apply model/reasoning immediately to the live design session. */
  onModelChange?: (modelId?: string, reasoningEffort?: ReasoningEffort) => void;
}) {
  const { studio, studioDispatch } = useStudioCanvas();
  const { state } = useStore();
  // Local picks for a brand-new chat; once a session exists, prefer its model.
  const [localModelId, setLocalModelId] = useState<string | undefined>(undefined);
  const [localReasoning, setLocalReasoning] = useState<ReasoningEffort | undefined>(undefined);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [count, setCount] = useState(1);
  const [countOpen, setCountOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const {
    images,
    addFiles,
    onPaste,
    remove: removeImage,
    clear: clearImages,
  } = useImageAttachments();

  // Session value first: setModel dispatches MISSION_SET_MODEL optimistically,
  // so it reflects a pick instantly and stays correct across thread switches
  // (a lingering local pick would leak into other threads). Local only covers
  // the pre-session compose.
  const modelId = sessionModelId ?? localModelId;
  const selectedFrame =
    studio.selectedFrameIds.length === 1
      ? studio.frames.find((f) => f.id === studio.selectedFrameIds[0])
      : undefined;
  const chips = studio.selection;
  const canSend = text.trim().length > 0 || images.length > 0;
  const selectedModel = modelId ? state.models.find((m) => m.id === modelId) : undefined;
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  // Session-first for the same reason as the model above; never show a level
  // the model doesn't support (e.g. leftover "max" from the previous model).
  const rawReasoning = sessionReasoning ?? localReasoning;
  const reasoningEffort = snapEffort(selectedModel, rawReasoning);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${String(Math.min(ta.scrollHeight, 200))}px`;
  };

  // Keep height in sync when the text is set externally (e.g. a suggestion).
  useEffect(grow, [text]);

  // If the live session still carries an unsupported effort (after a model switch),
  // snap it so the badge and the next send agree with the catalog.
  useEffect(() => {
    if (!sessionModelId || !sessionReasoning || efforts.length === 0) return;
    if (efforts.includes(sessionReasoning)) return;
    const snapped = snapEffort(selectedModel, undefined);
    setLocalReasoning(snapped);
    onModelChange?.(sessionModelId, snapped);
  }, [sessionModelId, sessionReasoning, efforts, selectedModel, onModelChange]);

  const pickModel = (next?: string) => {
    const model = next ? state.models.find((m) => m.id === next) : undefined;
    const snapped = snapEffort(model, localReasoning ?? sessionReasoning);
    setLocalModelId(next);
    setLocalReasoning(snapped);
    onModelChange?.(next, snapped);
  };

  const pickReasoning = (next: ReasoningEffort) => {
    setLocalReasoning(next);
    onModelChange?.(modelId, next);
  };

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), {
      modelId,
      reasoningEffort,
      count,
      images: images.length > 0 ? images : undefined,
    });
    onTextChange('');
    clearImages();
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  return (
    <div className="px-3 pb-3">
      <div className="rounded-2xl border border-droid-border bg-droid-elevated shadow-[0_10px_40px_-12px_rgba(0,0,0,0.6)] transition-colors focus-within:border-droid-border">
        {/* Reference chips + attached images */}
        {(chips.length > 0 || selectedFrame !== undefined || images.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 pt-3">
            {selectedFrame && (
              <Chip
                label={selectedFrame.name}
                sub={frameHost(selectedFrame.url)}
                kind="frame"
                onRemove={() => {
                  studioDispatch({ type: 'SELECT_FRAMES', ids: [] });
                }}
              />
            )}
            {chips.map((c) => (
              <Chip
                key={c.id}
                label={c.label}
                sub={c.tag}
                kind="element"
                onRemove={() => {
                  studioDispatch({ type: 'REMOVE_SELECTION', id: c.id });
                }}
              />
            ))}
            {images.map((src, i) => (
              <span key={i} className="group relative">
                <img
                  src={src}
                  alt="attachment"
                  className="h-10 w-10 rounded-md object-cover ring-1 ring-white/10"
                />
                <button
                  onClick={() => {
                    removeImage(i);
                  }}
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/85 text-droid-text-secondary opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            onTextChange(e.target.value);
            grow();
          }}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Ask for a design, paste an image, @ or select on canvas to reference designs."
          className="max-h-[200px] w-full resize-none bg-transparent px-3.5 pt-3 pb-2 text-[13.5px] leading-relaxed text-droid-text placeholder:text-droid-text-muted focus:outline-none"
        />

        {/* Controls: selectors wrap onto their own line so a long model name
            never collides with the fan-out/send in the narrow 336px column. */}
        <div className="space-y-1.5 px-2.5 pb-2.5 pt-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Model selector — fed by the real Droid CLI catalog */}
            <StudioModelPicker value={modelId} onChange={pickModel} />
            {/* Reasoning effort — shown when the picked model exposes a choice */}
            {efforts.length > 1 && (
              <Selector
                open={reasoningOpen}
                setOpen={setReasoningOpen}
                value={reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? 'auto'}
                onPick={(v) => {
                  pickReasoning(v as ReasoningEffort);
                }}
                options={efforts}
                width="w-32"
                icon={<Gauge className="h-3 w-3" />}
                align="left"
                hint="reasoning"
              />
            )}
            {/* Generation-count fan-out */}
            <Selector
              open={countOpen}
              setOpen={setCountOpen}
              value={`${String(count)}×`}
              onPick={(v) => {
                setCount(Number(v.replace('×', '')));
              }}
              options={COUNTS.map((c) => `${String(c)}×`)}
              width="w-24"
              icon={<Copy className="h-3 w-3" />}
              align="left"
              hint="directions"
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-0.5">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <IconChip title="Attach an image" onClick={() => fileRef.current?.click()}>
                <ImagePlus className="h-4 w-4" />
              </IconChip>
              <IconChip
                title="Mention a component or frame"
                onClick={() => {
                  onTextChange(text.endsWith(' ') || text === '' ? `${text}@` : `${text} @`);
                  taRef.current?.focus();
                }}
              >
                <AtSign className="h-4 w-4" />
              </IconChip>
            </div>

            {streaming ? (
              <button
                onClick={() => onStop?.()}
                title="Working — click to stop"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#ee6018] text-black shadow-[0_0_18px_-4px_rgba(238,96,24,0.7)] transition-all duration-150 hover:bg-[#ff6a1e] active:scale-95"
              >
                <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!canSend}
                title={disabledReason ?? 'Send (Enter)'}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all duration-150 ${
                  canSend
                    ? 'bg-[#ee6018] text-black shadow-[0_0_18px_-4px_rgba(238,96,24,0.7)] hover:bg-[#ff6a1e] active:scale-95 active:bg-[#dd5812]'
                    : 'cursor-not-allowed bg-white/[0.03] text-droid-text-muted'
                }`}
              >
                <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>
      {disabledReason && (
        <div className="px-2 pt-1.5 text-[11px] text-droid-text-muted">{disabledReason}</div>
      )}
    </div>
  );
}

function Chip({
  label,
  sub,
  kind,
  onRemove,
}: {
  label: string;
  sub?: string;
  kind: 'frame' | 'element';
  onRemove?: () => void;
}) {
  // Element references read as "hot" (ready to act on); frame chips stay muted
  // context so the two never blur together.
  const style =
    kind === 'frame'
      ? 'rounded-md border border-droid-border bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-droid-text-secondary'
      : 'rounded-lg border-[1.5px] border-[#ee6018]/40 bg-[#ee6018]/[0.12] px-2 py-0.5 text-[11.5px] font-medium text-[#f0a060]';
  return (
    <span className={`inline-flex items-center gap-1 ${style}`}>
      <span className="max-w-[140px] truncate">{label}</span>
      {sub && <span className="font-mono text-[9.5px] opacity-60">{sub}</span>}
      {onRemove && (
        <button onClick={onRemove} className="opacity-60 transition-opacity hover:opacity-100">
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}

function IconChip({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-droid-text-muted transition-colors hover:bg-white/[0.06] hover:text-droid-text"
    >
      {children}
    </button>
  );
}

function Selector({
  open,
  setOpen,
  value,
  onPick,
  options,
  width,
  icon,
  align = 'left',
  hint,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  value: string;
  onPick: (v: string) => void;
  options: string[];
  width: string;
  icon?: React.ReactNode;
  align?: 'left' | 'right';
  hint?: string;
}) {
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => {
          setOpen(!open);
        }}
        className="flex items-center gap-1.5 rounded-lg border border-droid-border bg-white/[0.03] px-2 py-1.5 text-[11.5px] text-droid-text-secondary transition-colors hover:border-droid-border hover:text-droid-text"
      >
        {icon}
        {value}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => {
                setOpen(false);
              }}
            />
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={{ type: 'spring', damping: 24, stiffness: 340 }}
              className={`absolute bottom-full z-20 mb-1.5 ${width} overflow-hidden rounded-xl border border-droid-border bg-droid-elevated p-1 shadow-2xl ${
                align === 'right' ? 'right-0' : 'left-0'
              }`}
            >
              {hint && (
                <div className="mb-1 border-b border-droid-border px-2 pb-1.5 pt-0.5 font-mono text-[9.5px] uppercase tracking-wider text-droid-text-muted">
                  {hint}
                </div>
              )}
              {options.map((o) => (
                <button
                  key={o}
                  onClick={() => {
                    onPick(o);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ${
                    o === value
                      ? 'bg-[#ee6018]/12 text-[#f08a52]'
                      : 'text-droid-text-secondary hover:bg-white/[0.06]'
                  }`}
                >
                  {o}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
