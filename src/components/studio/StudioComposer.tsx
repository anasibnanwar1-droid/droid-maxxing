import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Copy, Gauge, ImagePlus, PenLine, Square, X } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { useStudioCanvas } from './StudioCanvasContext';
import StudioModelPicker from './StudioModelPicker';
import { useImageAttachments } from './useImageAttachments';
import { buildStudioPrompt } from './studioPromptContext';
import { resolveStudioDefaultModel, resolveStudioModelId } from './studioModels';
import StudioSelector from './StudioSelector';
import type { ReasoningEffort } from '../../types/bridge';

export interface SendOptions {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  count: number;
  images?: string[];
  displayText?: string;
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
  hasSession,
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
  hasSession: boolean;
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
  const modelId = resolveStudioModelId(hasSession, sessionModelId, localModelId);
  const selectedFrame =
    studio.selectedFrameIds.length === 1
      ? studio.frames.find((f) => f.id === studio.selectedFrameIds[0])
      : undefined;
  const chips = studio.selection;
  const attachedAnnotations = studio.annotations.filter((annotation) =>
    studio.attachedAnnotationIds.includes(annotation.id),
  );
  const hasContent = text.trim().length > 0 || images.length > 0 || attachedAnnotations.length > 0;
  const canSend = hasContent && disabledReason === undefined;
  const selectedModel = modelId
    ? state.models.find((m) => m.id === modelId)
    : resolveStudioDefaultModel(state.models, state.agentConfig.primary.modelId);
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  // Session-first for the same reason as the model above; never show a level
  // the model doesn't support (e.g. leftover "max" from the previous model).
  const rawReasoning = hasSession ? sessionReasoning : localReasoning;
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
    if (!hasSession || !sessionReasoning || efforts.length === 0) return;
    if (efforts.includes(sessionReasoning)) return;
    const snapped = snapEffort(selectedModel, undefined);
    onModelChange?.(sessionModelId, snapped);
  }, [hasSession, sessionModelId, sessionReasoning, efforts, selectedModel, onModelChange]);

  const pickModel = (next?: string) => {
    const model = next
      ? state.models.find((candidate) => candidate.id === next)
      : resolveStudioDefaultModel(state.models, state.agentConfig.primary.modelId);
    const snapped = snapEffort(model, rawReasoning);
    if (hasSession) {
      onModelChange?.(next, snapped);
    } else {
      setLocalModelId(next);
      setLocalReasoning(snapped);
    }
  };

  const pickReasoning = (next: ReasoningEffort) => {
    if (hasSession) {
      onModelChange?.(modelId, next);
    } else {
      setLocalReasoning(next);
    }
  };

  const submit = () => {
    if (!canSend) return;
    const studioPrompt = buildStudioPrompt(text, studio);
    onSend(studioPrompt.prompt, {
      modelId,
      reasoningEffort,
      count,
      images: images.length > 0 ? images : undefined,
      displayText: studioPrompt.displayText,
    });
    onTextChange('');
    clearImages();
    studioDispatch({ type: 'CLEAR_ANNOTATION_CONTEXT' });
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  return (
    <div className="border-t border-droid-border bg-droid-surface/35 px-3 pb-3 pt-3">
      <div className="rounded-xl border border-droid-border bg-droid-bg/75 shadow-sm transition-colors focus-within:border-droid-border-hover">
        {/* Reference chips + attached images */}
        {(chips.length > 0 ||
          selectedFrame !== undefined ||
          images.length > 0 ||
          attachedAnnotations.length > 0) && (
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
            {attachedAnnotations.length > 0 && (
              <Chip
                label="Canvas notes"
                sub={`${String(attachedAnnotations.length)} mark${
                  attachedAnnotations.length === 1 ? '' : 's'
                }`}
                kind="drawing"
                onRemove={() => {
                  studioDispatch({ type: 'CLEAR_ANNOTATION_CONTEXT' });
                }}
              />
            )}
            {images.map((src, i) => (
              <span key={i} className="group relative">
                <img
                  src={src}
                  alt="attachment"
                  className="h-10 w-10 rounded-md object-cover ring-1 ring-droid-border"
                />
                <button
                  onClick={() => {
                    removeImage(i);
                  }}
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-droid-active text-droid-text-secondary opacity-0 transition-opacity group-hover:opacity-100"
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
          placeholder="Describe a design change…"
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
              <StudioSelector
                open={reasoningOpen}
                setOpen={setReasoningOpen}
                value={reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? 'auto'}
                onPick={(v) => {
                  pickReasoning(v as ReasoningEffort);
                }}
                options={efforts}
                width={128}
                icon={<Gauge className="h-3 w-3" />}
                hint="reasoning"
              />
            )}
            {/* Generation-count fan-out */}
            <StudioSelector
              open={countOpen}
              setOpen={setCountOpen}
              value={`${String(count)}×`}
              onPick={(v) => {
                setCount(Number(v.replace('×', '')));
              }}
              options={COUNTS.map((c) => `${String(c)}×`)}
              width={96}
              icon={<Copy className="h-3 w-3" />}
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
              <span className="px-1 text-[10.5px] text-droid-text-muted">@ mention</span>
            </div>

            {streaming ? (
              <button
                onClick={() => onStop?.()}
                title="Working — click to stop"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-droid-accent text-droid-bg transition-opacity duration-150 hover:opacity-90 active:translate-y-px"
              >
                <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!canSend}
                title={disabledReason ?? 'Send (Enter)'}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all duration-150 ${
                  canSend
                    ? 'bg-droid-accent text-droid-bg hover:opacity-90 active:translate-y-px'
                    : 'cursor-not-allowed bg-droid-elevated text-droid-text-muted'
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
  kind: 'frame' | 'element' | 'drawing';
  onRemove?: () => void;
}) {
  // Element references read as "hot" (ready to act on); frame chips stay muted
  // context so the two never blur together.
  const style = {
    frame:
      'rounded-md border border-droid-border bg-droid-elevated px-1.5 py-0.5 text-[11px] text-droid-text-secondary',
    element:
      'rounded-lg border border-droid-accent/30 bg-droid-accent/10 px-2 py-0.5 text-[11.5px] font-medium text-droid-accent',
    drawing:
      'rounded-lg border border-droid-accent/30 bg-droid-accent/10 px-2 py-1 text-[11.5px] font-medium text-droid-accent',
  }[kind];
  return (
    <span className={`inline-flex items-center gap-1 ${style}`}>
      {kind === 'drawing' && <PenLine className="h-3 w-3" strokeWidth={1.75} />}
      <span className="max-w-[140px] truncate">{label}</span>
      {sub && <span className="text-[9.5px] opacity-60">{sub}</span>}
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
      className="flex h-8 w-8 items-center justify-center rounded-lg text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text"
    >
      {children}
    </button>
  );
}
