export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  ttl: number;
}

type Listener = (toasts: ToastItem[]) => void;

const DEFAULT_TTL_MS = 3200;

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

// Live auto-dismiss timers plus each toast's remaining time when paused
// (hovered), so the countdown can resume where it left off.
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const remaining = new Map<number, number>();
const startedAt = new Map<number, number>();

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

function scheduleDismiss(id: number, ms: number): void {
  if (typeof setTimeout === 'undefined') return;
  clearTimeout(timers.get(id));
  startedAt.set(id, Date.now());
  remaining.set(id, ms);
  timers.set(
    id,
    setTimeout(() => {
      dismissToast(id);
    }, ms),
  );
}

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  remaining.delete(id);
  startedAt.delete(id);
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function pauseToast(id: number): void {
  if (!timers.has(id)) return;
  clearTimeout(timers.get(id));
  timers.delete(id);
  const left = (remaining.get(id) ?? 0) - (Date.now() - (startedAt.get(id) ?? Date.now()));
  remaining.set(id, Math.max(0, left));
}

export function resumeToast(id: number): void {
  if (timers.has(id) || !remaining.has(id)) return;
  const left = remaining.get(id) ?? 0;
  if (left <= 0) {
    dismissToast(id);
    return;
  }
  scheduleDismiss(id, left);
}

export function pushToast(
  message: string,
  variant: ToastVariant = 'info',
  ttl = DEFAULT_TTL_MS,
): number {
  const id = nextId++;
  toasts = [...toasts, { id, message, variant, ttl }];
  emit();
  if (ttl > 0) scheduleDismiss(id, ttl);
  return id;
}

export const toast = {
  success: (message: string) => pushToast(message, 'success'),
  error: (message: string) => pushToast(message, 'error'),
  info: (message: string) => pushToast(message, 'info'),
};

// Test-only: reset module state between cases.
export function __resetToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  remaining.clear();
  startedAt.clear();
  toasts = [];
  nextId = 1;
  listeners.clear();
}
