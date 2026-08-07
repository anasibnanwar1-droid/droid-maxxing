import { useSyncExternalStore } from 'react';

export function subscribeVisibilityChange(callback: () => void): () => void {
  document.addEventListener('visibilitychange', callback);
  return () => document.removeEventListener('visibilitychange', callback);
}

export function isDocumentVisible(): boolean {
  return document.visibilityState === 'visible';
}

function visibleServerSnapshot(): boolean {
  return true;
}

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibilityChange, isDocumentVisible, visibleServerSnapshot);
}
