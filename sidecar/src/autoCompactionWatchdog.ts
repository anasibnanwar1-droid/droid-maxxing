// Watchdog timers for the daemon's in-place auto-compaction. The
// "compacting" flag on a session is set by a compacting_conversation
// notification and normally cleared by session_compacted (or an idle working
// state). If that completion never arrives (dropped notification, daemon
// error, subscription swap), the flag would latch forever and the session
// would ignore every send and interrupt. These timers bound how long the flag
// may stay up before the owner is forced to settle it.

// A compaction of even a huge context finishes well within this bound.
export const AUTO_COMPACTION_WATCHDOG_MS = 5 * 60_000;
// Once the streaming turn has ended, any mid-turn compaction is already over;
// a still-raised flag is almost certainly stale, so settle it quickly.
export const POST_TURN_AUTO_COMPACTION_WATCHDOG_MS = 60_000;

export class AutoCompactionWatchdogs {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly onExpire: (sessionKey: string) => void) {}

  // (Re)arm the timer for one session. Re-arming with a shorter deadline is
  // how the post-turn check tightens the bound set at compaction start.
  arm(sessionKey: string, ms: number): void {
    this.clear(sessionKey);
    const timer = setTimeout(() => {
      this.timers.delete(sessionKey);
      this.onExpire(sessionKey);
    }, ms);
    // Never keep the process alive just for a watchdog.
    timer.unref?.();
    this.timers.set(sessionKey, timer);
  }

  isArmed(sessionKey: string): boolean {
    return this.timers.has(sessionKey);
  }

  clear(sessionKey: string): void {
    const timer = this.timers.get(sessionKey);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(sessionKey);
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
