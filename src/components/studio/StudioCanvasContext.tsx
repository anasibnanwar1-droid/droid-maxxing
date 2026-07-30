import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import type { BrowserViewportMode } from '../../types/bridge';
import { PRESET_VIEWPORTS, FIT_FALLBACK_VIEWPORT } from '../browser/browserViewport';
import { DEFAULT_VIEW, type CanvasView } from './studioCanvasMath';

export type StudioTool = 'select' | 'hand' | 'frame' | 'draw';
export type StudioLeftTab = 'agent' | 'components' | 'libraries';
export type StudioFrameKind = 'route' | 'generated' | 'showcase' | 'prototype';
export type StudioFrameStatus = 'loading' | 'ready' | 'building' | 'failed';
export type StudioAnnotationKind =
  | 'pencil'
  | 'line'
  | 'arrow'
  | 'rectangle'
  | 'square'
  | 'ellipse'
  | 'measure';
export type StudioAnnotationColor = 'blue' | 'red' | 'green' | 'amber';
export type StudioAnnotationFill = 'none' | StudioAnnotationColor;
export type StudioStrokeWidth = 1 | 2 | 4;

export interface StudioAnnotationPoint {
  x: number;
  y: number;
}

export interface StudioAnnotation {
  id: string;
  kind: StudioAnnotationKind;
  points: StudioAnnotationPoint[];
  color: StudioAnnotationColor;
  fill: StudioAnnotationFill;
  strokeWidth: StudioStrokeWidth;
  /** Points are frame-local when set, otherwise canvas world coordinates. */
  frameId?: string;
}

export interface StudioDrawingStyle {
  kind: StudioAnnotationKind;
  color: StudioAnnotationColor;
  fill: StudioAnnotationFill;
  strokeWidth: StudioStrokeWidth;
}

export interface StudioFrame {
  id: string;
  name: string;
  url: string;
  mode: BrowserViewportMode;
  kind: StudioFrameKind;
  // Explicit size for free/custom frames; presets derive size from `mode`.
  width?: number;
  height?: number;
  // World-space top-left of the frame's viewport box.
  x: number;
  y: number;
  status: StudioFrameStatus;
  reloadRevision: number;
  // Set while an agent is actively working the frame (colored border + cursor).
  agentLabel?: string;
  error?: string;
}

/** A resolved on-canvas selection that becomes context for the next prompt. */
export interface StudioSelection {
  id: string;
  frameId: string;
  frameName: string;
  label: string;
  tag?: string;
  selector?: string;
  file?: string;
  line?: number;
}

export interface StudioSettings {
  // Double-click a frame to interact with the live app inside it (scroll/click),
  // instead of the frame only being a selectable preview.
  interactOnDoubleClick: boolean;
}

export interface StudioCanvasState {
  view: CanvasView;
  tool: StudioTool;
  leftTab: StudioLeftTab;
  defaultMode: BrowserViewportMode;
  frames: StudioFrame[];
  selectedFrameIds: string[];
  selection: StudioSelection[];
  annotations: StudioAnnotation[];
  attachedAnnotationIds: string[];
  selectedAnnotationId: string | null;
  drawingStyle: StudioDrawingStyle;
  settings: StudioSettings;
  // The frame currently in interactive mode (its iframe receives pointer events).
  interactingFrameId: string | null;
  // Bumped on every HYDRATE so views can tell a thread-switch restore apart
  // from an organic frame add (no fly-to, no entrance animation).
  hydrateCount: number;
}

export type StudioCanvasAction =
  | { type: 'SET_VIEW'; view: CanvasView }
  | { type: 'SET_TOOL'; tool: StudioTool }
  | { type: 'SET_LEFT_TAB'; tab: StudioLeftTab }
  | { type: 'SET_DEFAULT_MODE'; mode: BrowserViewportMode }
  | { type: 'SET_SETTING'; key: keyof StudioSettings; value: boolean }
  | { type: 'SET_INTERACTING'; id: string | null }
  | { type: 'ADD_FRAME'; frame: NewFrame }
  | { type: 'UPDATE_FRAME'; id: string; patch: Partial<StudioFrame> }
  | { type: 'RELOAD_FRAME'; id: string }
  | { type: 'MOVE_FRAME'; id: string; x: number; y: number }
  | { type: 'REMOVE_FRAME'; id: string }
  | { type: 'SELECT_FRAMES'; ids: string[] }
  | { type: 'TOGGLE_FRAME'; id: string; additive: boolean }
  | { type: 'ADD_SELECTION'; selection: StudioSelection; additive: boolean }
  | { type: 'REMOVE_SELECTION'; id: string }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'SET_DRAWING_KIND'; kind: StudioAnnotationKind }
  | { type: 'SET_DRAWING_COLOR'; color: StudioAnnotationColor }
  | { type: 'SET_DRAWING_FILL'; fill: StudioAnnotationFill }
  | { type: 'SET_DRAWING_STROKE'; strokeWidth: StudioStrokeWidth }
  | { type: 'ADD_ANNOTATION'; annotation: StudioAnnotation }
  | { type: 'UPDATE_ANNOTATION'; id: string; annotation: StudioAnnotation }
  | { type: 'SELECT_ANNOTATION'; id: string | null }
  | { type: 'REMOVE_ANNOTATION'; id: string }
  | { type: 'UNDO_ANNOTATION' }
  | { type: 'CLEAR_ANNOTATIONS' }
  | { type: 'CLEAR_ANNOTATION_CONTEXT' }
  // Restore a snapshot when switching design threads (per-thread canvas).
  | { type: 'HYDRATE'; state: StudioCanvasState };

export interface NewFrame {
  name: string;
  url: string;
  mode?: BrowserViewportMode;
  kind?: StudioFrameKind;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  // Optional stable id (e.g. a preview): re-adding an existing id is a no-op so
  // regenerated previews update in place instead of duplicating.
  id?: string;
}

const GAP = 96; // world-space gutter between auto-placed frames
const MAX_FRAMES = 24; // guard against runaway frame creation pegging the machine
const MAX_ANNOTATIONS = 128;

export function frameSize(mode: BrowserViewportMode): { width: number; height: number } {
  const preset = PRESET_VIEWPORTS[mode] ?? FIT_FALLBACK_VIEWPORT;
  return { width: preset.width, height: preset.height };
}

/** Rendered size of a frame — its explicit free size, or its preset. */
export function sizeOf(frame: Pick<StudioFrame, 'mode' | 'width' | 'height'>): {
  width: number;
  height: number;
} {
  if (frame.width && frame.height) return { width: frame.width, height: frame.height };
  return frameSize(frame.mode);
}

export function newFrameId(): string {
  try {
    return `frame_${crypto.randomUUID().slice(0, 8)}`;
  } catch {
    return `frame_${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
  }
}

function selectionId(): string {
  try {
    return `sel_${crypto.randomUUID().slice(0, 8)}`;
  } catch {
    return `sel_${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
  }
}

/** Place a new frame to the right of the current row so nothing overlaps. */
function autoPosition(frames: StudioFrame[]): { x: number; y: number } {
  if (frames.length === 0) return { x: 0, y: 0 };
  let maxRight = -Infinity;
  let topOfRow = 0;
  for (const f of frames) {
    const size = sizeOf(f);
    if (f.x + size.width > maxRight) {
      maxRight = f.x + size.width;
      topOfRow = f.y;
    }
  }
  return { x: maxRight + GAP, y: topOfRow };
}

const initialState: StudioCanvasState = {
  view: { ...DEFAULT_VIEW },
  tool: 'select',
  leftTab: 'agent',
  defaultMode: 'desktop',
  frames: [],
  selectedFrameIds: [],
  selection: [],
  annotations: [],
  attachedAnnotationIds: [],
  selectedAnnotationId: null,
  drawingStyle: { kind: 'pencil', color: 'blue', fill: 'none', strokeWidth: 2 },
  settings: { interactOnDoubleClick: true },
  interactingFrameId: null,
  hydrateCount: 0,
};

export function studioCanvasReducer(
  state: StudioCanvasState,
  action: StudioCanvasAction,
): StudioCanvasState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, view: action.view };
    case 'SET_TOOL':
      return {
        ...state,
        tool: action.tool,
        interactingFrameId: action.tool === 'select' ? state.interactingFrameId : null,
      };
    case 'SET_LEFT_TAB':
      return { ...state, leftTab: action.tab };
    case 'SET_DEFAULT_MODE':
      return { ...state, defaultMode: action.mode };
    case 'SET_SETTING':
      return { ...state, settings: { ...state.settings, [action.key]: action.value } };
    case 'SET_INTERACTING':
      return { ...state, interactingFrameId: action.id };
    case 'ADD_FRAME': {
      if (action.frame.id && state.frames.some((f) => f.id === action.frame.id)) return state;
      if (state.frames.length >= MAX_FRAMES) return state;
      const mode = action.frame.mode ?? state.defaultMode;
      const pos =
        action.frame.x != null && action.frame.y != null
          ? { x: action.frame.x, y: action.frame.y }
          : autoPosition(state.frames);
      const frame: StudioFrame = {
        id: action.frame.id ?? newFrameId(),
        name: action.frame.name,
        url: action.frame.url,
        mode,
        kind: action.frame.kind ?? 'route',
        width: action.frame.width,
        height: action.frame.height,
        x: pos.x,
        y: pos.y,
        status: 'loading',
        reloadRevision: 0,
      };
      return { ...state, frames: [...state.frames, frame], selectedFrameIds: [frame.id] };
    }
    case 'UPDATE_FRAME':
      return {
        ...state,
        frames: state.frames.map((f) => {
          if (f.id !== action.id) return f;
          // Switching viewport mode must actually resize: explicit width/height
          // (free/showcase frames) would otherwise override the preset in
          // sizeOf() and make the toggle a silent no-op.
          const dropSize =
            action.patch.mode !== undefined &&
            action.patch.width === undefined &&
            action.patch.height === undefined;
          return dropSize
            ? { ...f, ...action.patch, width: undefined, height: undefined }
            : { ...f, ...action.patch };
        }),
      };
    case 'RELOAD_FRAME':
      return {
        ...state,
        frames: state.frames.map((frame) =>
          frame.id === action.id
            ? {
                ...frame,
                reloadRevision: frame.reloadRevision + 1,
                status: 'loading',
                error: undefined,
              }
            : frame,
        ),
      };
    case 'MOVE_FRAME':
      return {
        ...state,
        frames: state.frames.map((f) =>
          f.id === action.id ? { ...f, x: action.x, y: action.y } : f,
        ),
      };
    case 'REMOVE_FRAME':
      return {
        ...state,
        frames: state.frames.filter((f) => f.id !== action.id),
        selectedFrameIds: state.selectedFrameIds.filter((id) => id !== action.id),
        selection: state.selection.filter((s) => s.frameId !== action.id),
        annotations: state.annotations.filter((annotation) => annotation.frameId !== action.id),
        attachedAnnotationIds: state.attachedAnnotationIds.filter((id) => {
          const annotation = state.annotations.find((candidate) => candidate.id === id);
          return annotation?.frameId !== action.id;
        }),
        interactingFrameId:
          state.interactingFrameId === action.id ? null : state.interactingFrameId,
        selectedAnnotationId:
          state.annotations.find((annotation) => annotation.id === state.selectedAnnotationId)
            ?.frameId === action.id
            ? null
            : state.selectedAnnotationId,
      };
    case 'SELECT_FRAMES':
      return { ...state, selectedFrameIds: action.ids };
    case 'TOGGLE_FRAME': {
      if (!action.additive) return { ...state, selectedFrameIds: [action.id] };
      const has = state.selectedFrameIds.includes(action.id);
      return {
        ...state,
        selectedFrameIds: has
          ? state.selectedFrameIds.filter((id) => id !== action.id)
          : [...state.selectedFrameIds, action.id],
      };
    }
    case 'ADD_SELECTION': {
      const base = action.additive ? state.selection : [];
      const sel = { ...action.selection, id: action.selection.id || selectionId() };
      return { ...state, selection: [...base, sel] };
    }
    case 'REMOVE_SELECTION':
      return { ...state, selection: state.selection.filter((s) => s.id !== action.id) };
    case 'CLEAR_SELECTION':
      return { ...state, selection: [] };
    case 'SET_DRAWING_KIND':
      return { ...state, drawingStyle: { ...state.drawingStyle, kind: action.kind } };
    case 'SET_DRAWING_COLOR':
      return { ...state, drawingStyle: { ...state.drawingStyle, color: action.color } };
    case 'SET_DRAWING_FILL':
      return { ...state, drawingStyle: { ...state.drawingStyle, fill: action.fill } };
    case 'SET_DRAWING_STROKE':
      return { ...state, drawingStyle: { ...state.drawingStyle, strokeWidth: action.strokeWidth } };
    case 'ADD_ANNOTATION':
      if (state.annotations.length >= MAX_ANNOTATIONS) return state;
      return {
        ...state,
        annotations: [...state.annotations, action.annotation],
        attachedAnnotationIds: [...state.attachedAnnotationIds, action.annotation.id],
        selectedAnnotationId: action.annotation.id,
      };
    case 'UPDATE_ANNOTATION':
      return {
        ...state,
        annotations: state.annotations.map((annotation) =>
          annotation.id === action.id ? action.annotation : annotation,
        ),
      };
    case 'SELECT_ANNOTATION':
      return { ...state, selectedAnnotationId: action.id };
    case 'REMOVE_ANNOTATION':
      return {
        ...state,
        annotations: state.annotations.filter((annotation) => annotation.id !== action.id),
        attachedAnnotationIds: state.attachedAnnotationIds.filter((id) => id !== action.id),
        selectedAnnotationId:
          state.selectedAnnotationId === action.id ? null : state.selectedAnnotationId,
      };
    case 'UNDO_ANNOTATION': {
      const removed = state.annotations.at(-1);
      if (!removed) return state;
      return {
        ...state,
        annotations: state.annotations.slice(0, -1),
        attachedAnnotationIds: state.attachedAnnotationIds.filter((id) => id !== removed.id),
        selectedAnnotationId:
          state.selectedAnnotationId === removed.id ? null : state.selectedAnnotationId,
      };
    }
    case 'CLEAR_ANNOTATIONS':
      return {
        ...state,
        annotations: [],
        attachedAnnotationIds: [],
        selectedAnnotationId: null,
      };
    case 'CLEAR_ANNOTATION_CONTEXT':
      return { ...state, attachedAnnotationIds: [] };
    case 'HYDRATE':
      return {
        ...action.state,
        // Always drop interactive mode on restore — the iframe needs a fresh attach.
        interactingFrameId: null,
        hydrateCount: state.hydrateCount + 1,
      };
    default:
      return state;
  }
}

export function emptyStudioCanvasState(): StudioCanvasState {
  return {
    view: { ...DEFAULT_VIEW },
    tool: 'select',
    leftTab: 'agent',
    defaultMode: 'desktop',
    frames: [],
    selectedFrameIds: [],
    selection: [],
    annotations: [],
    attachedAnnotationIds: [],
    selectedAnnotationId: null,
    drawingStyle: { kind: 'pencil', color: 'blue', fill: 'none', strokeWidth: 2 },
    settings: { interactOnDoubleClick: true },
    interactingFrameId: null,
    hydrateCount: 0,
  };
}

const StudioCanvasContext = createContext<{
  studio: StudioCanvasState;
  studioDispatch: Dispatch<StudioCanvasAction>;
} | null>(null);

export function StudioCanvasProvider({ children }: { children: ReactNode }) {
  const [studio, studioDispatch] = useReducer(studioCanvasReducer, initialState);
  const value = useMemo(() => ({ studio, studioDispatch }), [studio]);
  return <StudioCanvasContext.Provider value={value}>{children}</StudioCanvasContext.Provider>;
}

export function useStudioCanvas() {
  const ctx = useContext(StudioCanvasContext);
  if (!ctx) throw new Error('useStudioCanvas must be used within StudioCanvasProvider');
  return ctx;
}
