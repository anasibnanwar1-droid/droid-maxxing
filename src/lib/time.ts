// Compact, social-style relative timestamp ("now", "23m", "1h", "3d", "2w").
// Used in the sidebar to show how long ago a session last had model activity.
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffMs = now - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${String(min)}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${String(hr)}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${String(day)}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${String(wk)}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${String(mo)}mo`;
  return `${String(Math.floor(day / 365))}y`;
}
