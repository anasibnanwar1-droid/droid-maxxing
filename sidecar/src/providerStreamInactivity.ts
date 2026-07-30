export const PRIMARY_STREAM_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1_000;

export type ScheduleInactivityTimer = (callback: () => void, timeoutMs: number) => () => void;

export interface ProviderStreamInactivityOptions {
  timeoutMs?: number;
  scheduleTimer?: ScheduleInactivityTimer;
  settleInactivity?: (error: ProviderStreamInactivityError) => Promise<void>;
}

export type ProviderStreamInactivityConfig = Pick<
  ProviderStreamInactivityOptions,
  'timeoutMs' | 'scheduleTimer'
>;

export class ProviderStreamInactivityError extends Error {
  constructor(timeoutMs: number) {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
    super(
      `The provider stopped sending updates for ${String(minutes)} minutes. The turn was released; send again to continue.`,
    );
    this.name = 'ProviderStreamInactivityError';
  }
}

/**
 * Gives a provider stream its own abort signal and rejects when no event arrives
 * before the inactivity deadline. Every provider event starts a fresh deadline.
 */
export async function* guardProviderStream<T>(
  createStream: (abortSignal: AbortSignal) => AsyncIterable<T>,
  parentAbortSignal: AbortSignal,
  options: ProviderStreamInactivityOptions = {},
): AsyncGenerator<T, void, undefined> {
  const timeoutMs = options.timeoutMs ?? PRIMARY_STREAM_INACTIVITY_TIMEOUT_MS;
  const scheduleTimer = options.scheduleTimer ?? scheduleDefaultTimer;
  const streamAbortController = new AbortController();
  const abortFromParent = (): void => {
    streamAbortController.abort(parentAbortSignal.reason);
  };
  if (parentAbortSignal.aborted) abortFromParent();
  else parentAbortSignal.addEventListener('abort', abortFromParent, { once: true });

  const iterator = createStream(streamAbortController.signal)[Symbol.asyncIterator]();
  let completed = false;
  let failure: unknown;
  let inactivitySettled = false;
  try {
    for (;;) {
      const result = await nextWithDeadline(
        iterator,
        timeoutMs,
        scheduleTimer,
        streamAbortController,
      );
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } catch (error) {
    failure = error;
    if (error instanceof ProviderStreamInactivityError && options.settleInactivity) {
      await options.settleInactivity(error);
      inactivitySettled = true;
    }
    throw error;
  } finally {
    parentAbortSignal.removeEventListener('abort', abortFromParent);
    if (!completed && !inactivitySettled && !streamAbortController.signal.aborted) {
      streamAbortController.abort(failure);
    }
    closeIteratorBestEffort(iterator);
  }
}

async function nextWithDeadline<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  scheduleTimer: ScheduleInactivityTimer,
  streamAbortController: AbortController,
): Promise<IteratorResult<T>> {
  let cancelTimer = (): void => undefined;
  let removeAbortListener = (): void => undefined;
  const deadline = new Promise<never>((_, reject) => {
    cancelTimer = scheduleTimer(() => {
      const error = new ProviderStreamInactivityError(timeoutMs);
      reject(error);
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    const abort = (): void => {
      reject(abortReason(streamAbortController.signal));
    };
    if (streamAbortController.signal.aborted) abort();
    else {
      streamAbortController.signal.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => {
        streamAbortController.signal.removeEventListener('abort', abort);
      };
    }
  });
  try {
    return await Promise.race([iterator.next(), deadline, aborted]);
  } finally {
    cancelTimer();
    removeAbortListener();
  }
}

function closeIteratorBestEffort<T>(iterator: AsyncIterator<T>): void {
  try {
    void iterator.return?.().catch(() => undefined);
  } catch {
    // The owned signal is already cancelled; cleanup cannot hold turn settlement open.
  }
}

function scheduleDefaultTimer(callback: () => void, timeoutMs: number): () => void {
  const timer = setTimeout(callback, timeoutMs);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof signal.reason === 'string') return new Error(signal.reason);
  return new Error('The provider stream was aborted.');
}
