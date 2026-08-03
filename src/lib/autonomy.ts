import type { Autonomy } from '../types/bridge';

// Autonomy levels, labels, and consequence descriptions mirror the Factory
// SDK's AutonomyLevel contract. The persisted app default lives in
// localStorage, initializes to Medium on first run, and is edited only from
// Settings; per-draft and per-session values never rewrite it.

export const AUTONOMY_LEVELS: readonly Autonomy[] = ['off', 'low', 'medium', 'high'];

export const FIRST_RUN_DEFAULT_AUTONOMY: Autonomy = 'medium';

export const AUTONOMY_LABELS: Record<Autonomy, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const AUTONOMY_DESCRIPTIONS: Record<Autonomy, string> = {
  off: 'You confirm every action before it runs.',
  low: 'File edits and read-only commands run without asking.',
  medium: 'Reversible commands run without asking.',
  high: 'All commands run without asking.',
};

const DEFAULT_AUTONOMY_STORAGE_KEY = 'droid-default-autonomy';

function getLocalStorage(): Storage | undefined {
  if (typeof window !== 'undefined') return window.localStorage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  return descriptor && 'value' in descriptor ? (descriptor.value as Storage) : undefined;
}

export function normalizeAutonomy(value: unknown): Autonomy | undefined {
  if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

export function loadDefaultAutonomy(): Autonomy {
  try {
    return (
      normalizeAutonomy(getLocalStorage()?.getItem(DEFAULT_AUTONOMY_STORAGE_KEY)) ??
      FIRST_RUN_DEFAULT_AUTONOMY
    );
  } catch {
    return FIRST_RUN_DEFAULT_AUTONOMY;
  }
}

export function saveDefaultAutonomy(level: Autonomy): void {
  try {
    getLocalStorage()?.setItem(DEFAULT_AUTONOMY_STORAGE_KEY, level);
  } catch {
    /* ignore */
  }
}

// Missions drive the product's most autonomous behavior, so starting one
// requires High autonomy; anything lower is an explicit user choice to make.
export function missionStartAllowed(level: Autonomy): boolean {
  return level === 'high';
}
