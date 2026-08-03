export type AppIconMode = 'system' | 'light' | 'dark';

export function normalizeAppIconMode(value: unknown): AppIconMode {
  if (value === 'light') return 'light';
  if (value === 'dark') return 'dark';
  return 'system';
}
