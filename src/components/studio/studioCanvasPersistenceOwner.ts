import { bridge } from '../../lib/bridge';
import { readDesignCanvas, writeDesignCanvas } from '../../lib/commands';
import type { CanvasDocumentContent, ServerEvent } from '../../types/bridge';
import type { StudioCanvasState } from './StudioCanvasContext';
import {
  CanvasSaveCoordinator,
  type CanvasOpenStatus,
  type CanvasPersistenceTarget,
  type CanvasPersistenceTransport,
  type HydratedStudioCanvas,
  type SerializedStudioCanvas,
  serializeStudioCanvas,
} from './studioCanvasPersistence';

type CanvasEvent = Extract<
  ServerEvent,
  { type: 'design.canvas.state' | 'design.canvas.saved' | 'design.canvas.error' }
>;

interface PersistenceCallbacks {
  onHydrate: (hydrated: HydratedStudioCanvas) => void;
  onNotice: (notices: string[]) => void;
  onSerialize?: (notices: string[]) => void;
}

type Subscribe = (listener: (event: ServerEvent) => void) => () => void;
type SubscribeOpen = (listener: () => void) => () => void;
type Schedule = (callback: () => void, delayMs: number) => () => void;
type Serialize = () => SerializedStudioCanvas;

const SERIALIZATION_DELAY_MS = 500;

/** One app-lifetime owner prevents remounts from racing the same canvas writes. */
export class StudioCanvasPersistenceOwner {
  private readonly coordinator: CanvasSaveCoordinator;
  private callbacks: PersistenceCallbacks | null = null;
  private isWaitingForHydration = false;
  private ignoredHydrationContent: string | null = null;
  private pendingSerialization: Serialize | null = null;
  private cancelSerialization: (() => void) | null = null;
  private readonly unsubscribeEvents: () => void;
  private readonly unsubscribeOpen: () => void;
  private readonly schedule: Schedule;

  constructor(
    transport: CanvasPersistenceTransport,
    subscribe: Subscribe,
    schedule: Schedule = defaultSchedule,
    subscribeOpen: SubscribeOpen = () => () => undefined,
  ) {
    this.schedule = schedule;
    this.coordinator = new CanvasSaveCoordinator(
      transport,
      (hydrated) => {
        this.isWaitingForHydration = false;
        this.ignoredHydrationContent = JSON.stringify(
          serializeStudioCanvas(hydrated.state).content,
        );
        this.callbacks?.onHydrate(hydrated);
      },
      (notices) => this.callbacks?.onNotice(notices),
      schedule,
    );
    this.unsubscribeEvents = subscribe((event) => {
      if (!isCanvasEvent(event)) return;
      this.receive(event);
    });
    this.unsubscribeOpen = subscribeOpen(() => {
      if (this.callbacks && this.isWaitingForHydration) this.coordinator.refresh();
    });
  }

  attach(callbacks: PersistenceCallbacks): () => void {
    if (this.callbacks) throw new Error('Studio canvas persistence already has a UI owner.');
    this.callbacks = callbacks;
    return () => {
      if (this.callbacks !== callbacks) return;
      this.flush();
      this.callbacks = null;
      this.isWaitingForHydration = false;
    };
  }

  open(target: CanvasPersistenceTarget, current: CanvasDocumentContent): CanvasOpenStatus {
    this.flushPendingSerialization();
    const status = this.coordinator.open(target, current);
    // Opening a different target emits an immediate empty placeholder. That is
    // not the authoritative restore, so keep waiting until state arrives—or a
    // pending local save settles and triggers the re-read below.
    this.isWaitingForHydration = true;
    if (status !== 'started') this.coordinator.refresh();
    return status;
  }

  update(studio: StudioCanvasState): void {
    this.pendingSerialization = () => serializeStudioCanvas(studio);
    this.cancelSerialization?.();
    this.cancelSerialization = this.schedule(() => {
      this.cancelSerialization = null;
      this.flushPendingSerialization();
      this.coordinator.flush();
    }, SERIALIZATION_DELAY_MS);
  }

  flush(): void {
    this.flushPendingSerialization();
    this.coordinator.flush();
  }

  destroy(): void {
    this.cancelSerialization?.();
    this.cancelSerialization = null;
    this.pendingSerialization = null;
    this.unsubscribeEvents();
    this.unsubscribeOpen();
  }

  private receive(event: CanvasEvent): void {
    // Materialize the latest local snapshot before applying a server revision,
    // so edits made during restore or an in-flight save retain their ordering.
    this.flushPendingSerialization();
    this.coordinator.receive(event);
    if (this.callbacks && this.isWaitingForHydration && event.type === 'design.canvas.saved') {
      this.coordinator.refresh();
    }
  }

  private flushPendingSerialization(): void {
    this.cancelSerialization?.();
    this.cancelSerialization = null;
    const serialize = this.pendingSerialization;
    this.pendingSerialization = null;
    if (!serialize) return;
    const serialized = serialize();
    this.callbacks?.onSerialize?.(serialized.notices);
    const ignoredHydrationContent = this.ignoredHydrationContent;
    this.ignoredHydrationContent = null;
    if (JSON.stringify(serialized.content) === ignoredHydrationContent) {
      return;
    }
    this.coordinator.update(serialized.content);
  }
}

export const studioCanvasPersistenceOwner = new StudioCanvasPersistenceOwner(
  { read: readDesignCanvas, write: writeDesignCanvas },
  (listener) => bridge.subscribe(listener),
  undefined,
  (listener) =>
    bridge.subscribeOpen(() => {
      listener();
      return [];
    }),
);

function isCanvasEvent(event: ServerEvent): event is CanvasEvent {
  return (
    event.type === 'design.canvas.state' ||
    event.type === 'design.canvas.saved' ||
    event.type === 'design.canvas.error'
  );
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const id = window.setTimeout(callback, delayMs);
  return () => {
    window.clearTimeout(id);
  };
}
