// Dismissible cards pinned above the sidebar footer (the welcome card today,
// future "what's new" announcements later). Dismissal persists per card id so
// a new announcement can show without resurrecting ones the user already closed.
const SEEN_KEY_PREFIX = 'droid-sidebar-card-seen:';

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

export function loadSidebarCardSeen(cardId: string): boolean {
  try {
    return getLocalStorage()?.getItem(SEEN_KEY_PREFIX + cardId) === '1';
  } catch {
    // Storage unavailable: stay quiet rather than nag on every mount.
    return true;
  }
}

export function dismissSidebarCard(cardId: string): void {
  try {
    getLocalStorage()?.setItem(SEEN_KEY_PREFIX + cardId, '1');
  } catch {
    /* ignore */
  }
}
