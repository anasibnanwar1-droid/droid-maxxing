import type {
  CanvasDocument,
  CanvasDocumentContent,
  CanvasFrameSource,
  CanvasFrameRuntime,
  CanvasImageAsset,
  ServerEvent,
} from '../../types/bridge';
import {
  emptyStudioCanvasState,
  type StudioCanvasState,
  type StudioFrame,
} from './StudioCanvasContext';

export const DRAFT_CANVAS_ID = 'studio-draft';
const AUTOSAVE_DELAY_MS = 500;
export type CanvasOpenStatus = 'started' | 'pending' | 'ready';

export interface CanvasPersistenceTarget {
  cwd: string;
  projectKey: string;
  canvasId: string;
}

export interface CanvasPersistenceTransport {
  read(cwd: string, canvasId: string): void;
  write(input: {
    cwd: string;
    canvasId: string;
    expectedRevision: number;
    content: CanvasDocumentContent;
  }): void;
}

export interface SerializedStudioCanvas {
  content: CanvasDocumentContent;
  notices: string[];
}

export interface HydratedStudioCanvas {
  state: StudioCanvasState;
  notices: string[];
}

type CanvasEvent = Extract<
  ServerEvent,
  { type: 'design.canvas.state' | 'design.canvas.saved' | 'design.canvas.error' }
>;

type CancelSchedule = () => void;

export function canvasIdForSession(appSessionId: string | null | undefined): string {
  return appSessionId === undefined || appSessionId === null || appSessionId === ''
    ? DRAFT_CANVAS_ID
    : appSessionId;
}

export function serializeStudioCanvas(studio: StudioCanvasState): SerializedStudioCanvas {
  const frames = studio.frames.filter(hasDurableSource);
  const frameIds = new Set(frames.map((frame) => frame.id));
  const annotations = studio.annotations.filter(
    (annotation) => annotation.frameId === undefined || frameIds.has(annotation.frameId),
  );
  const notices: string[] = [];
  const omittedFrames = studio.frames.length - frames.length;
  const omittedAnnotations = studio.annotations.length - annotations.length;
  if (omittedFrames > 0) {
    notices.push(
      `${String(omittedFrames)} runtime-only frame${omittedFrames === 1 ? '' : 's'} cannot reopen until added from a durable URL or preview source.`,
    );
  }
  if (omittedAnnotations > 0) {
    notices.push(
      `${String(omittedAnnotations)} drawing${omittedAnnotations === 1 ? '' : 's'} anchored to those frames cannot be saved.`,
    );
  }
  return {
    content: {
      view: {
        pan: { ...studio.view.pan },
        zoom: studio.view.zoom,
      },
      frames: frames.map((frame) => ({
        id: frame.id,
        name: frame.name,
        source: frame.source,
        kind: frame.kind,
        viewport: {
          mode: frame.mode,
          ...(frame.width !== undefined && frame.height !== undefined
            ? { width: frame.width, height: frame.height }
            : {}),
        },
        x: frame.x,
        y: frame.y,
      })),
      annotations: annotations.map((annotation) => ({
        id: annotation.id,
        kind: annotation.kind,
        points: annotation.points.map((point) => ({ ...point })),
        color: annotation.color,
        fill: annotation.fill,
        strokeWidth: annotation.strokeWidth,
        ...(annotation.frameId === undefined ? {} : { frameId: annotation.frameId }),
      })),
      images: studio.images.map((image) => ({
        id: image.id,
        libraryId: image.libraryId,
        tag: image.tag,
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
      })),
    },
    notices,
  };
}

export function hydrateStudioCanvas(
  document: CanvasDocument | null,
  runtimes: CanvasFrameRuntime[],
  assets: CanvasImageAsset[],
): HydratedStudioCanvas {
  if (!document) return { state: emptyStudioCanvasState(), notices: [] };
  const runtimeByFrame = new Map(runtimes.map((runtime) => [runtime.frameId, runtime]));
  const assetByLibrary = new Map(assets.map((asset) => [asset.libraryId, asset]));
  const notices: string[] = [];
  const frames: StudioFrame[] = document.frames.map((frame) => {
    const runtime = runtimeByFrame.get(frame.id);
    const error =
      runtime?.error ?? (runtime?.url ? undefined : 'This frame could not be reopened.');
    if (error) notices.push(`${frame.name}: ${error}`);
    return {
      id: frame.id,
      name: frame.name,
      source: frame.source,
      url: runtime?.url ?? 'about:blank',
      mode: frame.viewport.mode,
      kind: frame.kind,
      ...(frame.viewport.width === undefined ? {} : { width: frame.viewport.width }),
      ...(frame.viewport.height === undefined ? {} : { height: frame.viewport.height }),
      x: frame.x,
      y: frame.y,
      status: runtime?.url ? 'loading' : 'failed',
      reloadRevision: 0,
      ...(error === undefined ? {} : { error }),
    };
  });
  const images = document.images.flatMap((placement) => {
    const asset = assetByLibrary.get(placement.libraryId);
    if (!asset?.url) {
      notices.push(
        `Canvas image ${placement.libraryId}: ${asset?.error ?? 'The durable image file is missing.'}`,
      );
      return [];
    }
    return [
      {
        ...placement,
        src: asset.url,
        name: asset.name ?? 'Canvas image',
        naturalWidth: placement.width,
        naturalHeight: placement.height,
      },
    ];
  });
  return {
    state: {
      ...emptyStudioCanvasState(),
      view: {
        pan: { ...document.view.pan },
        zoom: document.view.zoom,
      },
      frames,
      annotations: document.annotations.map(({ frameId, ...annotation }) => ({
        ...annotation,
        points: annotation.points.map((point) => ({ ...point })),
        ...(frameId === undefined ? {} : { frameId }),
      })),
      images,
    },
    notices,
  };
}

export class CanvasSaveCoordinator {
  private target: CanvasPersistenceTarget | null = null;
  private revision = 0;
  private isLoaded = false;
  private current: CanvasDocumentContent | null = null;
  private lastSaved = '';
  private localGeneration = 0;
  private restoreGeneration = 0;
  private writeInFlight = false;
  private writeFailureCount = 0;
  private readonly detachedWrites = new Map<
    string,
    { target: CanvasPersistenceTarget; content: CanvasDocumentContent }
  >();
  private cancelSchedule: CancelSchedule | null = null;

  constructor(
    private readonly transport: CanvasPersistenceTransport,
    private readonly onHydrate: (hydrated: HydratedStudioCanvas) => void,
    private readonly onNotice: (notices: string[]) => void,
    private readonly schedule: (
      callback: () => void,
      delayMs: number,
    ) => CancelSchedule = defaultSchedule,
  ) {}

  open(target: CanvasPersistenceTarget, current: CanvasDocumentContent): CanvasOpenStatus {
    const previous = this.target;
    if (
      previous?.cwd === target.cwd &&
      previous.projectKey === target.projectKey &&
      previous.canvasId === target.canvasId
    ) {
      return this.isLoaded ? 'ready' : 'pending';
    }
    this.flush();
    this.detachPendingWrite();
    const promotesDraft =
      previous?.projectKey === target.projectKey &&
      previous.canvasId === DRAFT_CANVAS_ID &&
      target.canvasId !== DRAFT_CANVAS_ID;
    const sameCanvas =
      previous?.projectKey === target.projectKey && previous.canvasId === target.canvasId;
    this.target = target;
    this.current = cloneContent(current);
    this.localGeneration = 0;
    this.restoreGeneration = 0;
    this.writeInFlight = false;
    this.writeFailureCount = 0;
    this.cancelTimer();
    if (promotesDraft) {
      this.revision = 0;
      this.isLoaded = true;
      this.lastSaved = '';
      this.flush();
    } else {
      this.revision = 0;
      this.isLoaded = false;
      this.lastSaved = '';
      if (!sameCanvas) this.onHydrate(hydrateStudioCanvas(null, [], []));
    }
    this.transport.read(target.cwd, target.canvasId);
    return 'started';
  }

  update(content: CanvasDocumentContent): void {
    const serialized = stableContent(content);
    if (this.current === null || stableContent(this.current) !== serialized) {
      this.localGeneration += 1;
      this.current = cloneContent(content);
    }
    if (!this.isLoaded || stableContent(content) === this.lastSaved) {
      this.cancelTimer();
      return;
    }
    this.scheduleFlush(AUTOSAVE_DELAY_MS);
  }

  receive(event: CanvasEvent): void {
    if (!this.matches(event.cwd, event.canvasId)) {
      this.receiveDetached(event);
      return;
    }
    if (event.type === 'design.canvas.state') {
      this.receiveState(event);
      return;
    }
    if (event.type === 'design.canvas.saved') {
      this.receiveSaved(event);
      return;
    }
    this.receiveError(event);
  }

  private receiveState(event: Extract<CanvasEvent, { type: 'design.canvas.state' }>): void {
    this.cancelTimer();
    this.revision = event.document?.revision ?? 0;
    this.isLoaded = true;
    const content = event.document ? documentContent(event.document) : emptyContent();
    const hasNewerLocalContent = this.localGeneration !== this.restoreGeneration;
    this.lastSaved = stableContent(content);
    if (hasNewerLocalContent) {
      if (this.current && stableContent(this.current) !== this.lastSaved) {
        this.scheduleFlush(AUTOSAVE_DELAY_MS);
      }
      return;
    }
    this.current = cloneContent(content);
    this.onHydrate(hydrateStudioCanvas(event.document, event.frames, event.images));
  }

  private receiveSaved(event: Extract<CanvasEvent, { type: 'design.canvas.saved' }>): void {
    this.writeInFlight = false;
    this.writeFailureCount = 0;
    if (event.document.revision >= this.revision) {
      this.revision = event.document.revision;
      this.lastSaved = stableContent(documentContent(event.document));
    }
    if (this.current && stableContent(this.current) !== this.lastSaved) this.update(this.current);
  }

  private receiveError(event: Extract<CanvasEvent, { type: 'design.canvas.error' }>): void {
    this.onNotice([event.message]);
    if (event.operation === 'read') {
      this.isLoaded = true;
      const hasNewerLocalContent = this.localGeneration !== this.restoreGeneration;
      this.restoreGeneration = this.localGeneration;
      if (this.current) {
        this.lastSaved = hasNewerLocalContent ? '' : stableContent(this.current);
      }
      if (hasNewerLocalContent) this.scheduleFlush(AUTOSAVE_DELAY_MS);
      else this.scheduleReadRetry();
      return;
    }
    this.writeInFlight = false;
    if (event.actualRevision !== undefined) this.revision = event.actualRevision;
    this.writeFailureCount += 1;
    this.scheduleFlush(Math.min(AUTOSAVE_DELAY_MS * 2 ** this.writeFailureCount, 5_000));
  }

  flush(): void {
    this.cancelTimer();
    if (!this.target || !this.isLoaded || !this.current || this.writeInFlight) return;
    const serialized = stableContent(this.current);
    if (serialized === this.lastSaved) return;
    this.writeInFlight = true;
    this.transport.write({
      cwd: this.target.cwd,
      canvasId: this.target.canvasId,
      expectedRevision: this.revision,
      content: cloneContent(this.current),
    });
  }

  dispose(): void {
    this.flush();
    this.detachPendingWrite();
    this.target = null;
  }

  private detachPendingWrite(): void {
    if (!this.target || !this.current) return;
    if (stableContent(this.current) === this.lastSaved) return;
    this.detachedWrites.set(this.persistenceKey(this.target.cwd, this.target.canvasId), {
      target: this.target,
      content: cloneContent(this.current),
    });
  }

  private receiveDetached(event: CanvasEvent): void {
    const key = this.persistenceKey(event.cwd, event.canvasId);
    const pending = this.detachedWrites.get(key);
    if (!pending) return;
    if (event.type === 'design.canvas.saved') {
      const saved = stableContent(documentContent(event.document));
      if (stableContent(pending.content) === saved) {
        this.detachedWrites.delete(key);
        return;
      }
      this.transport.write({
        cwd: pending.target.cwd,
        canvasId: pending.target.canvasId,
        expectedRevision: event.document.revision,
        content: cloneContent(pending.content),
      });
      return;
    }
    if (event.type === 'design.canvas.error' && event.operation === 'write') {
      this.onNotice([event.message]);
      if (event.actualRevision === undefined) return;
      this.transport.write({
        cwd: pending.target.cwd,
        canvasId: pending.target.canvasId,
        expectedRevision: event.actualRevision,
        content: cloneContent(pending.content),
      });
    }
  }

  private persistenceKey(cwd: string, canvasId: string): string {
    return `${cwd}\u0000${canvasId}`;
  }

  private matches(cwd: string, canvasId: string): boolean {
    return this.target?.cwd === cwd && this.target.canvasId === canvasId;
  }

  private cancelTimer(): void {
    this.cancelSchedule?.();
    this.cancelSchedule = null;
  }

  private scheduleFlush(delayMs: number): void {
    this.cancelTimer();
    this.cancelSchedule = this.schedule(() => {
      this.cancelSchedule = null;
      this.flush();
    }, delayMs);
  }

  private scheduleReadRetry(): void {
    const target = this.target;
    if (!target) return;
    this.cancelTimer();
    this.cancelSchedule = this.schedule(() => {
      this.cancelSchedule = null;
      if (!this.matches(target.cwd, target.canvasId)) return;
      this.restoreGeneration = this.localGeneration;
      this.transport.read(target.cwd, target.canvasId);
    }, AUTOSAVE_DELAY_MS);
  }
}

function defaultSchedule(callback: () => void, delayMs: number): CancelSchedule {
  const timer = window.setTimeout(callback, delayMs);
  return () => {
    window.clearTimeout(timer);
  };
}

function documentContent(document: CanvasDocument): CanvasDocumentContent {
  return {
    view: document.view,
    frames: document.frames,
    annotations: document.annotations,
    images: document.images,
  };
}

function emptyContent(): CanvasDocumentContent {
  return serializeStudioCanvas(emptyStudioCanvasState()).content;
}

function stableContent(content: CanvasDocumentContent): string {
  return JSON.stringify(content);
}

function cloneContent(content: CanvasDocumentContent): CanvasDocumentContent {
  return JSON.parse(JSON.stringify(content)) as CanvasDocumentContent;
}

function hasDurableSource(
  frame: StudioFrame,
): frame is StudioFrame & { source: CanvasFrameSource } {
  return frame.source !== undefined;
}
