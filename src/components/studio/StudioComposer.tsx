import { useEffect, useState } from 'react';
import { Copy, Gauge, ImagePlus, PenLine, X } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { useStudioCanvas, type StudioCanvasImage } from './StudioCanvasContext';
import SessionComposer from '../SessionComposer';
import StudioModelPicker from './StudioModelPicker';
import { buildStudioPrompt } from './studioPromptContext';
import { resolveStudioDefaultModel, resolveStudioModelId } from './studioModels';
import StudioSelector from './StudioSelector';
import type { ReasoningEffort } from '../../types/bridge';
import { CANVAS_IMAGE_INPUT_ID } from './studioCanvasImages';
import StudioPromptQueue from './StudioPromptQueue';
import type { SessionPromptMode } from '../../lib/promptQueue';

export interface SendOptions {
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  count: number;
  canvasImages?: StudioCanvasImage[];
  displayText?: string;
  mode?: SessionPromptMode;
}

const COUNTS = [1, 2, 3, 4];
const NO_REASONING_EFFORTS: ReasoningEffort[] = [];

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
  const queue = sessionId ? (state.promptQueue[sessionId] ?? []) : [];
  const selectedModel = modelId
    ? state.models.find((m) => m.id === modelId)
    : resolveStudioDefaultModel(state.models, state.agentConfig.primary.modelId);
  const efforts = selectedModel?.supportedReasoningEfforts ?? NO_REASONING_EFFORTS;
  // Session-first for the same reason as the model above; never show a level
  // the model doesn't support (e.g. leftover "max" from the previous model).
  const rawReasoning = hasSession ? sessionReasoning : localReasoning;
  const reasoningEffort = snapEffort(selectedModel, rawReasoning);

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
      <SessionComposer
        value={text}
        onValueChange={(value) => {
          onTextChange(value);
        }}
        onSubmit={submit}
        isLive={streaming ?? false}
        hasContent={hasContent}
        canSubmit={canSend}
        liveEnterBehavior={state.liveEnterBehavior}
        placeholder="Describe a design change…"
        onStop={onStop}
        idleSendTitle={disabledReason ?? 'Enter: send\nShift+Enter: newline'}
        context={
          chips.length > 0 ||
          selectedFrame !== undefined ||
          attachedAnnotations.length > 0 ||
          canvasImages.length > 0 ? (
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
              {chips.map((chip) => (
                <Chip
                  key={chip.id}
                  label={chip.label}
                  sub={chip.tag}
                  kind="element"
                  onRemove={() => {
                    studioDispatch({ type: 'REMOVE_SELECTION', id: chip.id });
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
                  sub={`${String(canvasImages.length)} image${
                    canvasImages.length === 1 ? '' : 's'
                  }`}
                  kind="image"
                  onRemove={() => {
                    studioDispatch({ type: 'CLEAR_CANVAS_IMAGE_CONTEXT' });
                  }}
                />
              )}
            </div>
          ) : undefined
        }
        toolbarTop={
          <>
            <StudioModelPicker value={modelId} onChange={pickModel} />
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
          </>
        }
        toolbarLeading={
          <>
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
          </>
        }
      />
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
