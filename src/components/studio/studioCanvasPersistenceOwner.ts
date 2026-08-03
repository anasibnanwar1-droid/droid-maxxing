import { bridge } from '../../lib/bridge';
import { readDesignCanvas, writeDesignCanvas } from '../../lib/commands';
import type { CanvasDocumentContent, ServerEvent } from '../../types/bridge';
import {
  CanvasSaveCoordinator,
  type CanvasOpenStatus,
  type CanvasPersistenceTarget,
  type CanvasPersistenceTransport,
  type HydratedStudioCanvas,
  serializeStudioCanvas,
} from './studioCanvasPersistence';

type CanvasEvent = Extract<
  ServerEvent,
  { type: 'design.canvas.state' | 'design.canvas.saved' | 'design.canvas.error' }
>;

interface PersistenceCallbacks {
  onHydrate: (hydrated: HydratedStudioCanvas) => void;
  onNotice: (notices: string[]) => void;
}

type Subscribe = (listener: (event: ServerEvent) => void) => () => void;
type SubscribeOpen = (listener: () => void) => () => void;
type Schedule = (callback: () => void, delayMs: number) => () => void;

/** One app-lifetime owner prevents remounts from racing the same canvas writes. */
export class StudioCanvasPersistenceOwner {
  private readonly coordinator: CanvasSaveCoordinator;
  private callbacks: PersistenceCallbacks | null = null;
  private isWaitingForHydration = false;
  private ignoredHydrationContent: string | null = null;
  private readonly unsubscribeEvents: () => void;
  private readonly unsubscribeOpen: () => void;

  constructor(
    transport: CanvasPersistenceTransport,
    subscribe: Subscribe,
    schedule?: Schedule,
    subscribeOpen: SubscribeOpen = () => () => undefined,
  ) {
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
      this.coordinator.flush();
      this.callbacks = null;
      this.isWaitingForHydration = false;
    };
  }

  open(target: CanvasPersistenceTarget, current: CanvasDocumentContent): CanvasOpenStatus {
    const status = this.coordinator.open(target, current);
    // Opening a different target emits an immediate empty placeholder. That is
    // not the authoritative restore, so keep waiting until state arrives—or a
    // pending local save settles and triggers the re-read below.
    this.isWaitingForHydration = true;
    if (status !== 'started') this.coordinator.refresh();
    return status;
  }

  update(content: CanvasDocumentContent): void {
    const serialized = JSON.stringify(content);
    if (serialized === this.ignoredHydrationContent) {
      this.ignoredHydrationContent = null;
      return;
    }
    this.coordinator.update(content);
  }

  flush(): void {
    this.coordinator.flush();
  }

  destroy(): void {
    this.unsubscribeEvents();
    this.unsubscribeOpen();
  }

  private receive(event: CanvasEvent): void {
    this.coordinator.receive(event);
    if (this.callbacks && this.isWaitingForHydration && event.type === 'design.canvas.saved') {
      this.coordinator.refresh();
    }
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
