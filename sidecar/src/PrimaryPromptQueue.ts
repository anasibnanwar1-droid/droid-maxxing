export type PrimaryPromptPriority = 'queue' | 'steer';

export interface PrimaryQueuedPrompt {
  text: string;
  priority: PrimaryPromptPriority;
}

interface QueueEntry extends PrimaryQueuedPrompt {
  protected: boolean;
}

/**
 * Owns primary-session prompt ordering. An elected preflight prompt remains the
 * absolute head; later steers stay FIFO ahead of ordinary queued prompts.
 */
export class PrimaryPromptQueue {
  private readonly entries: QueueEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  enqueue(text: string, priority: PrimaryPromptPriority): void {
    const entry = { text, priority, protected: false };
    if (priority === 'queue') {
      this.entries.push(entry);
      return;
    }
    const firstOrdinary = this.entries.findIndex(
      (candidate) => !candidate.protected && candidate.priority === 'queue',
    );
    if (firstOrdinary < 0) this.entries.push(entry);
    else this.entries.splice(firstOrdinary, 0, entry);
  }

  protectHead(prompt: PrimaryQueuedPrompt): void {
    this.entries.unshift({ ...prompt, protected: true });
  }

  take(): PrimaryQueuedPrompt | undefined {
    const entry = this.entries.shift();
    return entry ? { text: entry.text, priority: entry.priority } : undefined;
  }

  drain(): PrimaryQueuedPrompt[] {
    const queued = this.entries.map(({ text, priority }) => ({ text, priority }));
    this.entries.length = 0;
    return queued;
  }

  clear(): void {
    this.entries.length = 0;
  }

  snapshot(): readonly (PrimaryQueuedPrompt & { protected: boolean })[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}
