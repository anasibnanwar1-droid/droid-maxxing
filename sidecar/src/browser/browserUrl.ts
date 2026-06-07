export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'about:blank';
  if (/^(https?:|file:|about:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  const ipv6Loopback = normalizeBareIpv6Loopback(trimmed);
  if (ipv6Loopback) return ipv6Loopback;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?(\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

function normalizeBareIpv6Loopback(value: string): string | null {
  const match = /^::1(?::(\d+))?(\/.*)?$/i.exec(value);
  if (!match) return null;
  const port = match[1] ? `:${match[1]}` : '';
  const path = match[2] ?? '';
  return `http://[::1]${port}${path}`;
}
