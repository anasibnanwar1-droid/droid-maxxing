import { Image as ImageIcon, Paperclip, Trash2 } from 'lucide-react';
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import {
  useStudioCanvas,
  type StudioCanvasImage,
  type StudioCanvasImageTag,
} from './StudioCanvasContext';
import { worldToScreen } from './studioCanvasMath';

type ResizeHandle = 'nw' | 'ne' | 'se' | 'sw';

interface ImageGesture {
  id: string;
  mode: 'move' | 'resize';
  handle?: ResizeHandle;
  startClientX: number;
  startClientY: number;
  original: StudioCanvasImage;
  zoom: number;
}

const TAGS: { value: StudioCanvasImageTag; label: string }[] = [
  { value: 'moodboard', label: 'Moodboard' },
  { value: 'inspiration', label: 'Inspiration' },
  { value: 'reference', label: 'Reference' },
];

export default function CanvasImageLayer() {
  const { studio, studioDispatch } = useStudioCanvas();
  const gestureRef = useRef<ImageGesture | null>(null);
  const selected = studio.images.find((image) => image.id === studio.selectedImageId);
  if (studio.images.length === 0) return null;

  const beginGesture = (event: ReactPointerEvent<HTMLDivElement>, image: StudioCanvasImage) => {
    if (studio.tool !== 'select' || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>('[data-image-resize]')?.dataset.imageResize as
      | ResizeHandle
      | undefined;
    gestureRef.current = {
      id: image.id,
      mode: handle ? 'resize' : 'move',
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      original: image,
      zoom: studio.view.zoom,
    };
    studioDispatch({ type: 'SELECT_CANVAS_IMAGE', id: image.id });
  };

  const moveGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    event.stopPropagation();
    const dx = (event.clientX - gesture.startClientX) / gesture.zoom;
    const dy = (event.clientY - gesture.startClientY) / gesture.zoom;
    const patch =
      gesture.mode === 'move'
        ? { x: gesture.original.x + dx, y: gesture.original.y + dy }
        : resizeImage(gesture.original, gesture.handle ?? 'se', dx, dy);
    studioDispatch({ type: 'UPDATE_CANVAS_IMAGE', id: gesture.id, patch });
  };

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gestureRef.current) return;
    event.stopPropagation();
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <>
      <div
        className="pointer-events-none absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate3d(${String(studio.view.pan.x)}px, ${String(studio.view.pan.y)}px, 0) scale(${String(studio.view.zoom)})`,
        }}
      >
        {studio.images.map((image) => {
          const isSelected = image.id === studio.selectedImageId;
          return (
            <div
              key={image.id}
              data-canvas-image={image.id}
              className={`group absolute overflow-hidden rounded-[14px] bg-droid-surface shadow-[0_18px_50px_-22px_rgba(0,0,0,0.65)] ${
                isSelected
                  ? 'ring-2 ring-droid-accent'
                  : 'ring-1 ring-droid-border hover:ring-droid-border-hover'
              }`}
              style={{
                left: image.x,
                top: image.y,
                width: image.width,
                height: image.height,
                pointerEvents: studio.tool === 'select' ? 'auto' : 'none',
                cursor: studio.tool === 'select' ? 'move' : 'default',
              }}
              onPointerDown={(event) => {
                beginGesture(event, image);
              }}
              onPointerMove={moveGesture}
              onPointerUp={finishGesture}
              onPointerCancel={finishGesture}
              onDoubleClick={(event) => {
                event.stopPropagation();
              }}
            >
              <img
                src={image.src}
                alt={image.name}
                draggable={false}
                className="h-full w-full select-none object-contain"
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-black/65 via-black/20 to-transparent px-3 pb-2.5 pt-8 opacity-90 transition-opacity group-hover:opacity-100">
                <span className="min-w-0 truncate text-[12px] font-medium text-white">
                  {image.name}
                </span>
                <span className="shrink-0 rounded-full bg-black/45 px-2 py-0.5 text-[9.5px] font-medium capitalize text-white/85 backdrop-blur-md">
                  {image.tag}
                </span>
              </div>
              {isSelected &&
                (['nw', 'ne', 'se', 'sw'] as const).map((handle) => (
                  <span
                    key={handle}
                    data-image-resize={handle}
                    className="absolute rounded-[3px] border border-droid-accent bg-droid-surface shadow-sm"
                    style={{
                      width: 10 / studio.view.zoom,
                      height: 10 / studio.view.zoom,
                      ...handlePosition(handle, studio.view.zoom),
                      cursor: handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize',
                    }}
                  />
                ))}
            </div>
          );
        })}
      </div>

      {selected && (
        <CanvasImageToolbar
          image={selected}
          onTag={(tag) => {
            studioDispatch({ type: 'UPDATE_CANVAS_IMAGE', id: selected.id, patch: { tag } });
          }}
          onRemove={() => {
            studioDispatch({ type: 'REMOVE_CANVAS_IMAGE', id: selected.id });
          }}
          attached={studio.attachedImageIds.includes(selected.id)}
          onAttachedChange={(attached) => {
            studioDispatch({ type: 'SET_CANVAS_IMAGE_ATTACHED', id: selected.id, attached });
          }}
        />
      )}
    </>
  );
}

function CanvasImageToolbar({
  image,
  onTag,
  onRemove,
  attached,
  onAttachedChange,
}: {
  image: StudioCanvasImage;
  onTag: (tag: StudioCanvasImageTag) => void;
  onRemove: () => void;
  attached: boolean;
  onAttachedChange: (attached: boolean) => void;
}) {
  const { studio } = useStudioCanvas();
  const topLeft = worldToScreen({ x: image.x, y: image.y }, studio.view);
  return (
    <div
      data-studio-dismissable-layer
      className="studio-floating-surface pointer-events-auto absolute z-20 flex items-center gap-0.5 rounded-xl p-1"
      style={{
        left: topLeft.x,
        top: topLeft.y - 10,
        transform: 'translateY(-100%)',
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      <span className="flex h-7 w-7 items-center justify-center text-droid-text-muted">
        <ImageIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
      </span>
      {TAGS.map((tag) => (
        <button
          key={tag.value}
          type="button"
          aria-pressed={image.tag === tag.value}
          onClick={() => {
            onTag(tag.value);
          }}
          className={`rounded-lg px-2 py-1 text-[10.5px] transition-colors ${
            image.tag === tag.value
              ? 'bg-droid-accent/10 text-droid-accent'
              : 'text-droid-text-muted hover:bg-droid-active/70 hover:text-droid-text'
          }`}
        >
          {tag.label}
        </button>
      ))}
      <div className="mx-0.5 h-4 w-px bg-droid-border" />
      <button
        type="button"
        title={attached ? 'Attached to the next prompt' : 'Attach to the next prompt'}
        aria-pressed={attached}
        onClick={() => {
          onAttachedChange(!attached);
        }}
        className={`flex h-7 items-center gap-1 rounded-lg px-2 text-[10.5px] transition-colors ${
          attached
            ? 'bg-droid-accent/10 text-droid-accent'
            : 'text-droid-text-muted hover:bg-droid-active/70 hover:text-droid-text'
        }`}
      >
        <Paperclip className="h-3 w-3" strokeWidth={1.75} />
        {attached ? 'Attached' : 'Attach'}
      </button>
      <button
        type="button"
        title="Remove from canvas"
        aria-label="Remove image from canvas"
        onClick={onRemove}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-droid-text-muted transition-colors hover:bg-droid-red/10 hover:text-droid-red"
      >
        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}

function resizeImage(
  image: StudioCanvasImage,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): Pick<StudioCanvasImage, 'x' | 'y' | 'width' | 'height'> {
  const aspect = image.width / image.height;
  const horizontalDelta = handle.includes('w') ? -dx : dx;
  const verticalDelta = (handle.includes('n') ? -dy : dy) * aspect;
  const change =
    Math.abs(horizontalDelta) >= Math.abs(verticalDelta) ? horizontalDelta : verticalDelta;
  const width = Math.max(96, image.width + change);
  const height = width / aspect;
  return {
    x: handle.includes('w') ? image.x + image.width - width : image.x,
    y: handle.includes('n') ? image.y + image.height - height : image.y,
    width,
    height,
  };
}

function handlePosition(handle: ResizeHandle, zoom: number) {
  const offset = -5 / zoom;
  return {
    left: handle.includes('w') ? offset : undefined,
    right: handle.includes('e') ? offset : undefined,
    top: handle.includes('n') ? offset : undefined,
    bottom: handle.includes('s') ? offset : undefined,
  };
}
