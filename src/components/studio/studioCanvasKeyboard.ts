import type { StudioTool } from './StudioCanvasContext';

type CanvasKeyboardEvent = Pick<KeyboardEvent, 'ctrlKey' | 'key' | 'metaKey' | 'target'>;

export function isStudioTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable;
}

export function shouldUndoCanvasAnnotation(event: CanvasKeyboardEvent, tool: StudioTool): boolean {
  return (
    tool === 'draw' &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === 'z' &&
    !isStudioTypingTarget(event.target)
  );
}
