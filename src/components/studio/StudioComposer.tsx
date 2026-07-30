import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Copy, Gauge, ImagePlus, PenLine, Square, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../../hooks/useStore';
import { useStudioCanvas, type StudioCanvasImage } from './StudioCanvasContext';
import StudioModelPicker from './StudioModelPicker';
import { buildStudioPrompt } from './studioPromptContext';
import { resolveStudioDefaultModel, resolveStudioModelId } from './studioModels';
import StudioSelector from './StudioSelector';
import type { ReasoningEffort } from '../../types/bridge';
import { CANVAS_IMAGE_INPUT_ID } from './studioCanvasImages';
import StudioPromptQueue from './StudioPromptQueue';
import { studioComposerActions } from './studioSession';
import { resolveSessionPromptMode, type SessionPromptMode } from '../../lib/promptQueue';

export interface SendOptions {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  count: number;
  canvasImages?: StudioCanvasImage[];
  displayText?: string;
  mode?: SessionPromptMode;
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
  sessionId,
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
  sessionId?: string | null;
  hasSession: boolean;
  /** Live session model (when a design chat already exists). */
  sessionModelId?: string;
  sessionReasoning?: ReasoningEffort;
  /** Apply model/reasoning immediately to the live design session. */
  onModelChange?: (modelId?: string, reasoningEffort?: ReasoningEffort) => void;
}) {
  const { studio, studioDispatch } = useStudioCanvas();
  const { state, dispatch } = useStore();
  // Local picks for a brand-new chat; once a session exists, prefer its model.
  const [localModelId, setLocalModelId] = useState<string | undefined>(undefined);
  const [localReasoning, setLocalReasoning] = useState<ReasoningEffort | undefined>(undefined);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [count, setCount] = useState(1);
  const [countOpen, setCountOpen] = useState(false);
  const [sendHover, setSendHover] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Session value first: setModel dispatches MISSION_SET_MODEL optimistically,
  // so it reflects a pick instantly and stays correct across thread switches
  // (a lingering local pick would leak into other threads). Local only covers
  // the pre-session compose.
  const defaultModelId =
    state.agentConfig.primary.modelId ??
    resolveStudioDefaultModel(state.models, state.agentConfig.primary.modelId)?.id;
  const modelId = resolveStudioModelId(hasSession, sessionModelId, localModelId, defaultModelId);
  const selectedFrame =
    studio.selectedFrameIds.length === 1
      ? studio.frames.find((f) => f.id === studio.selectedFrameIds[0])
      : undefined;
  const chips = studio.selection;
  const attachedAnnotations = studio.annotations.filter((annotation) =>
    studio.attachedAnnotationIds.includes(annotation.id),
  );
  const canvasImages = studio.images.filter((image) => studio.attachedImageIds.includes(image.id));
  const hasContent =
    text.trim().length > 0 || attachedAnnotations.length > 0 || canvasImages.length > 0;
  const canSend = hasContent && disabledReason === undefined;
  const actions = studioComposerActions(streaming ?? false, hasContent);
  const queue = sessionId ? (state.promptQueue[sessionId] ?? []) : [];
  const enterSteers = state.liveEnterBehavior === 'interrupt';
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

  const submit = (mode: SessionPromptMode = 'queue') => {
    if (!canSend) return;
    const studioPrompt = buildStudioPrompt(text, studio);
    onSend(studioPrompt.prompt, {
      modelId,
      reasoningEffort,
      count,
      canvasImages: canvasImages.length > 0 ? canvasImages : undefined,
      displayText: studioPrompt.displayText,
      mode,
    });
    onTextChange('');
    studioDispatch({ type: 'CLEAR_ANNOTATION_CONTEXT' });
    studioDispatch({ type: 'CLEAR_CANVAS_IMAGE_CONTEXT' });
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  return (
    <div className="border-t border-droid-border bg-droid-surface/35 px-3 pb-3 pt-3">
      {sessionId && (
        <StudioPromptQueue
          appSessionId={sessionId}
          queue={queue}
          onRemove={(appSessionId, id) => {
            dispatch({ type: 'REMOVE_QUEUED_PROMPT', appSessionId, id });
          }}
          onReorder={(appSessionId, from, to) => {
            dispatch({ type: 'REORDER_QUEUE', appSessionId, from, to });
          }}
        />
      )}
      <div className="rounded-xl border border-droid-border bg-droid-bg/75 shadow-sm transition-colors focus-within:border-droid-border-hover">
        {/* Reference chips + attached images */}
        {(chips.length > 0 ||
          selectedFrame !== undefined ||
          attachedAnnotations.length > 0 ||
          canvasImages.length > 0) && (
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
            {canvasImages.length > 0 && (
              <Chip
                label="Canvas moodboard"
                sub={`${String(canvasImages.length)} image${canvasImages.length === 1 ? '' : 's'}`}
                kind="image"
                onRemove={() => {
                  studioDispatch({ type: 'CLEAR_CANVAS_IMAGE_CONTEXT' });
                }}
              />
            )}
          </div>
        )}

        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            onTextChange(e.target.value);
            grow();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit(
                resolveSessionPromptMode({
                  isLive: streaming ?? false,
                  liveEnterBehavior: state.liveEnterBehavior,
                  alternate: e.metaKey || e.ctrlKey,
                }),
              );
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
              <IconChip
                title="Add an image to the canvas"
                onClick={() => {
                  document.getElementById(CANVAS_IMAGE_INPUT_ID)?.click();
                }}
              >
                <ImagePlus className="h-4 w-4" />
              </IconChip>
              <span className="px-1 text-[10.5px] text-droid-text-muted">@ mention</span>
            </div>

            {actions.showStop ? (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onStop?.()}
                  title="Working — click to stop"
                  aria-label="Stop current design turn"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-droid-accent text-droid-bg transition-opacity hover:opacity-90"
                >
                  <Square className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />
                </button>
                {actions.showSend && (
                  <div
                    className="relative shrink-0"
                    onMouseEnter={() => {
                      setSendHover(true);
                    }}
                    onMouseLeave={() => {
                      setSendHover(false);
                    }}
                  >
                    <AnimatePresence>
                      {sendHover && (
                        <motion.div
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 4 }}
                          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                          className="absolute bottom-full right-0 z-50 mb-2 flex flex-col gap-0.5 rounded-xl border border-droid-border bg-droid-elevated p-1.5 shadow-2xl shadow-black/40"
                        >
                          {[
                            { label: enterSteers ? 'Steer' : 'Queue', keys: ['⏎'] },
                            { label: enterSteers ? 'Queue' : 'Steer', keys: ['⌘', '⏎'] },
                          ].map((row) => (
                            <div
                              key={row.label}
                              className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 text-[12px] text-droid-text"
                            >
                              <span>{row.label}</span>
                              <span className="flex items-center gap-0.5 rounded-md bg-droid-bg/70 px-1.5 py-0.5 text-[11px] text-droid-text-secondary">
                                {row.keys.map((key) => (
                                  <kbd key={key} className="font-sans leading-none">
                                    {key}
                                  </kbd>
                                ))}
                              </span>
                            </div>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <button
                      type="button"
                      onClick={() => {
                        submit(
                          resolveSessionPromptMode({
                            isLive: streaming ?? false,
                            liveEnterBehavior: state.liveEnterBehavior,
                          }),
                        );
                      }}
                      aria-label={enterSteers ? 'Steer current design turn' : 'Queue design prompt'}
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-droid-text text-droid-bg transition-colors hover:bg-droid-text-secondary"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={() => {
                  submit();
                }}
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
  kind: 'frame' | 'element' | 'drawing' | 'image';
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
    image:
      'rounded-lg border border-droid-accent/30 bg-droid-accent/10 px-2 py-1 text-[11.5px] font-medium text-droid-accent',
  }[kind];
  return (
    <span className={`inline-flex items-center gap-1 ${style}`}>
      {kind === 'drawing' && <PenLine className="h-3 w-3" strokeWidth={1.75} />}
      {kind === 'image' && <ImagePlus className="h-3 w-3" strokeWidth={1.75} />}
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
