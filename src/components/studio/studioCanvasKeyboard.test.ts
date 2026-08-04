import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldUndoCanvasAnnotation } from './studioCanvasKeyboard';

function keyboardEvent(
  target: Partial<Pick<HTMLElement, 'isContentEditable' | 'tagName'>>,
  modifiers: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'> = { ctrlKey: false, metaKey: true },
): Pick<KeyboardEvent, 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'target'> {
  return {
    ...modifiers,
    key: 'z',
    shiftKey: false,
    target: target as EventTarget,
  };
}

test('canvas undo leaves native text editing shortcuts with typing targets', () => {
  assert.equal(
    shouldUndoCanvasAnnotation(
      keyboardEvent({ tagName: 'TEXTAREA' }, { ctrlKey: true, metaKey: false }),
      'draw',
    ),
    false,
  );
  assert.equal(shouldUndoCanvasAnnotation(keyboardEvent({ tagName: 'INPUT' }), 'draw'), false);
  assert.equal(
    shouldUndoCanvasAnnotation(keyboardEvent({ tagName: 'DIV', isContentEditable: true }), 'draw'),
    false,
  );
});

test('canvas undo reserves Cmd/Ctrl+Shift+Z for redo', () => {
  assert.equal(
    shouldUndoCanvasAnnotation(
      { ...keyboardEvent({ tagName: 'DIV', isContentEditable: false }), shiftKey: true },
      'draw',
    ),
    false,
  );
});

test('canvas undo remains active for the draw tool outside typing targets', () => {
  assert.equal(
    shouldUndoCanvasAnnotation(keyboardEvent({ tagName: 'DIV', isContentEditable: false }), 'draw'),
    true,
  );
  assert.equal(
    shouldUndoCanvasAnnotation(
      keyboardEvent({ tagName: 'DIV', isContentEditable: false }),
      'select',
    ),
    false,
  );
});
