export type PrimaryPromptPriority = 'queue' | 'steer';

export interface PrimaryQueuedPrompt {
  text: string;
  priority: PrimaryPromptPriority;
}

/**
 * Owns primary-session prompt ordering. Steers stay FIFO ahead of ordinary
 * queued prompts while preserving order within each priority.
 */
export class PrimaryPromptQueue {
  private readonly entries: PrimaryQueuedPrompt[] = [];

  get size(): number {
    return this.entries.length;
  }

  enqueue(text: string, priority: PrimaryPromptPriority): void {
    const entry = { text, priority };
    if (priority === 'queue') {
      this.entries.push(entry);
      return;
    }
    const firstOrdinary = this.entries.findIndex((candidate) => candidate.priority === 'queue');
    if (firstOrdinary < 0) this.entries.push(entry);
    else this.entries.splice(firstOrdinary, 0, entry);
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

  snapshot(): readonly PrimaryQueuedPrompt[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}
