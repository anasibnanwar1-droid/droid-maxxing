export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

type Listener = (toasts: ToastItem[]) => void;

const DEFAULT_TTL_MS = 3200;

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(toasts);
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function pushToast(message: string, variant: ToastVariant = 'info', ttl = DEFAULT_TTL_MS): number {
  const id = nextId++;
  toasts = [...toasts, { id, message, variant }];
  emit();
  if (ttl > 0 && typeof setTimeout !== 'undefined') {
    setTimeout(() => dismissToast(id), ttl);
  }
  return id;
}

export const toast = {
  success: (message: string) => pushToast(message, 'success'),
  error: (message: string) => pushToast(message, 'error'),
  info: (message: string) => pushToast(message, 'info'),
};

// Test-only: reset module state between cases.
export function __resetToasts(): void {
  toasts = [];
  nextId = 1;
  listeners.clear();
}
