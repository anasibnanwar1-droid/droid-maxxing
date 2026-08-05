// Watchdog timers for the daemon's in-place auto-compaction. The
// "compacting" flag on a session is set by a compacting_conversation
// notification and cleared only by the authoritative session_compacted event.
// If that completion never arrives (dropped notification, daemon
// error, subscription swap), the flag would latch forever and the session
// would ignore every send and interrupt. These timers bound how long the flag
// may stay up before the owner is forced to settle it.

// A compaction of even a huge context finishes well within this bound.
export const AUTO_COMPACTION_WATCHDOG_MS = 5 * 60_000;
// Once the streaming turn has ended, any mid-turn compaction is already over;
// a still-raised flag is almost certainly stale, so settle it quickly.
export const POST_TURN_AUTO_COMPACTION_WATCHDOG_MS = 60_000;

export class AutoCompactionWatchdogs<Key> {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private epoch = 0;

  constructor(
    private readonly keyOf: (key: Key) => string,
    private readonly onExpire: (key: Key) => void,
  ) {}

  // (Re)arm the timer for one compaction resource. Re-arming with a shorter deadline is
  // how the post-turn check tightens the bound set at compaction start.
  arm(key: Key, ms: number): void {
    const id = this.keyOf(key);
    this.clear(key);
    const epoch = this.epoch;
    const timer = setTimeout(() => {
      if (epoch !== this.epoch || this.timers.get(id) !== timer) return;
      this.timers.delete(id);
      this.onExpire(key);
    }, ms);
    // Never keep the process alive just for a watchdog.
    timer.unref();
    this.timers.set(id, timer);
  }

  isArmed(key: Key): boolean {
    return this.timers.has(this.keyOf(key));
  }

  clear(key: Key): void {
    const id = this.keyOf(key);
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  clearAll(): void {
    this.epoch += 1;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
