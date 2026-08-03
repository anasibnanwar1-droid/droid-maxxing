export type StudioCanvasImageTag = 'moodboard' | 'inspiration' | 'reference';
export const CANVAS_IMAGE_INPUT_ID = 'droidex-canvas-image-input';

export interface StudioCanvasImage {
  id: string;
  libraryId: string;
  src: string;
  name: string;
  tag: StudioCanvasImageTag;
  x: number;
  y: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

export interface StudioCanvasImageSlice {
  images: StudioCanvasImage[];
  selectedImageId: string | null;
  attachedImageIds: string[];
}

export type StudioCanvasImageAction =
  | { type: 'ADD_CANVAS_IMAGE'; image: StudioCanvasImage }
  | { type: 'UPDATE_CANVAS_IMAGE'; id: string; patch: Partial<StudioCanvasImage> }
  | { type: 'SELECT_CANVAS_IMAGE'; id: string | null }
  | { type: 'REMOVE_CANVAS_IMAGE'; id: string }
  | { type: 'SET_CANVAS_IMAGE_ATTACHED'; id: string; attached: boolean }
  | { type: 'CLEAR_CANVAS_IMAGE_CONTEXT' };

const MAX_CANVAS_IMAGES = 24;

export function emptyCanvasImageSlice(): StudioCanvasImageSlice {
  return { images: [], selectedImageId: null, attachedImageIds: [] };
}

export function reduceCanvasImages(
  state: StudioCanvasImageSlice,
  action: StudioCanvasImageAction,
): StudioCanvasImageSlice {
  switch (action.type) {
    case 'ADD_CANVAS_IMAGE':
      if (state.images.length >= MAX_CANVAS_IMAGES) return state;
      return {
        images: [...state.images, action.image],
        selectedImageId: action.image.id,
        attachedImageIds: [...state.attachedImageIds, action.image.id],
      };
    case 'UPDATE_CANVAS_IMAGE':
      return {
        ...state,
        images: state.images.map((image) =>
          image.id === action.id ? { ...image, ...action.patch } : image,
        ),
      };
    case 'SELECT_CANVAS_IMAGE':
      return { ...state, selectedImageId: action.id };
    case 'REMOVE_CANVAS_IMAGE':
      return {
        ...state,
        images: state.images.filter((image) => image.id !== action.id),
        selectedImageId: state.selectedImageId === action.id ? null : state.selectedImageId,
        attachedImageIds: state.attachedImageIds.filter((id) => id !== action.id),
      };
    case 'SET_CANVAS_IMAGE_ATTACHED': {
      let attachedImageIds = state.attachedImageIds;
      if (action.attached && !state.attachedImageIds.includes(action.id)) {
        attachedImageIds = [...state.attachedImageIds, action.id];
      } else if (!action.attached) {
        attachedImageIds = state.attachedImageIds.filter((id) => id !== action.id);
      }
      return {
        ...state,
        attachedImageIds,
      };
    }
    case 'CLEAR_CANVAS_IMAGE_CONTEXT':
      return { ...state, attachedImageIds: [] };
  }
}

export function isCanvasImageAction(action: { type: string }): action is StudioCanvasImageAction {
  return (
    action.type === 'ADD_CANVAS_IMAGE' ||
    action.type === 'UPDATE_CANVAS_IMAGE' ||
    action.type === 'SELECT_CANVAS_IMAGE' ||
    action.type === 'REMOVE_CANVAS_IMAGE' ||
    action.type === 'SET_CANVAS_IMAGE_ATTACHED' ||
    action.type === 'CLEAR_CANVAS_IMAGE_CONTEXT'
  );
}

export function fittedCanvasImageSize(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } {
  const safeWidth = Math.max(1, naturalWidth);
  const safeHeight = Math.max(1, naturalHeight);
  const fitScale = Math.min(1, 420 / safeWidth, 320 / safeHeight);
  const readableScale =
    fitScale < 1
      ? fitScale
      : Math.min(420 / safeWidth, 320 / safeHeight, Math.max(1, 96 / safeWidth, 72 / safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * readableScale)),
    height: Math.max(1, Math.round(safeHeight * readableScale)),
  };
}
