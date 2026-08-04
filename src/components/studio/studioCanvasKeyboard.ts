import type { StudioTool } from './StudioCanvasContext';

type CanvasKeyboardEvent = Pick<
  KeyboardEvent,
  'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'target'
>;

export function isStudioTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable;
}

export function isStudioInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, a, input, textarea, select, [role="button"]') !== null
  );
}

export function shouldUndoCanvasAnnotation(event: CanvasKeyboardEvent, tool: StudioTool): boolean {
  return (
    tool === 'draw' &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'z' &&
    !isStudioTypingTarget(event.target)
  );
}
