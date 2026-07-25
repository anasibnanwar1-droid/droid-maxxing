export function isTerminalTabShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'key'>): boolean {
  return event.ctrlKey && event.key === '`';
}

export function isTerminalInputTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  return typeof closest === 'function' && Boolean(closest.call(target, '[data-terminal-input]'));
}
