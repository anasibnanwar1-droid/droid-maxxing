export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  if (/^(https?:|file:|about:)/i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}
