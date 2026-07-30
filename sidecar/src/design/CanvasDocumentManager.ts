import type {
  CanvasFrameRuntime,
  CanvasFrameSource,
  CanvasImageAsset,
  ClientCommand,
  ServerEvent,
} from '../protocol.js';
import {
  CanvasDocumentRevisionConflictError,
  readCanvasDocument,
  writeCanvasDocument,
} from './canvasDocument.js';

type CanvasReadCommand = Extract<ClientCommand, { type: 'design.canvas.read' }>;
type CanvasWriteCommand = Extract<ClientCommand, { type: 'design.canvas.write' }>;

export interface CanvasDocumentManagerOptions {
  emit: (event: ServerEvent) => void;
  resolveFrameSource: (
    cwd: string,
    source: CanvasFrameSource,
  ) => Promise<{ url?: string; error?: string }>;
  resolveImageAsset: (
    cwd: string,
    libraryId: string,
  ) => Promise<{ name?: string; url?: string; error?: string }>;
  baseDir?: string;
}

export class CanvasDocumentManager {
  constructor(private readonly options: CanvasDocumentManagerOptions) {}

  async read(command: CanvasReadCommand): Promise<void> {
    try {
      const document = readCanvasDocument({
        cwd: command.cwd,
        threadId: command.canvasId,
        ...(this.options.baseDir === undefined ? {} : { baseDir: this.options.baseDir }),
      });
      const [frames, images] = document
        ? await Promise.all([
            this.resolveFrames(command.cwd, document.frames),
            this.resolveImages(command.cwd, document.images),
          ])
        : [[], []];
      this.options.emit({
        type: 'design.canvas.state',
        cwd: command.cwd,
        canvasId: command.canvasId,
        document,
        frames,
        images,
      });
    } catch (error) {
      this.emitError(command, 'read', error);
    }
  }

  write(command: CanvasWriteCommand): void {
    try {
      const document = writeCanvasDocument({
        cwd: command.cwd,
        threadId: command.canvasId,
        expectedRevision: command.expectedRevision,
        content: command.content,
        ...(this.options.baseDir === undefined ? {} : { baseDir: this.options.baseDir }),
      });
      this.options.emit({
        type: 'design.canvas.saved',
        cwd: command.cwd,
        canvasId: command.canvasId,
        document,
      });
    } catch (error) {
      this.emitError(command, 'write', error);
    }
  }

  private async resolveFrames(
    cwd: string,
    frames: { id: string; source: CanvasFrameSource }[],
  ): Promise<CanvasFrameRuntime[]> {
    return Promise.all(
      frames.map(async (frame) => {
        const runtime = await this.options.resolveFrameSource(cwd, frame.source);
        return { frameId: frame.id, ...runtime };
      }),
    );
  }

  private async resolveImages(
    cwd: string,
    placements: { libraryId: string }[],
  ): Promise<CanvasImageAsset[]> {
    return Promise.all(
      placements.map(async ({ libraryId }) => ({
        libraryId,
        ...(await this.options.resolveImageAsset(cwd, libraryId)),
      })),
    );
  }

  private emitError(
    command: CanvasReadCommand | CanvasWriteCommand,
    operation: 'read' | 'write',
    error: unknown,
  ): void {
    this.options.emit({
      type: 'design.canvas.error',
      cwd: command.cwd,
      canvasId: command.canvasId,
      operation,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof CanvasDocumentRevisionConflictError
        ? { actualRevision: error.actualRevision }
        : {}),
    });
  }
}
