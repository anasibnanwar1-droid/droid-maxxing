import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function source(name: string): string {
  return fs.readFileSync(new URL(name, import.meta.url), 'utf8');
}

test('annotation shapes remain hit-testable above frame chrome', () => {
  const layer = source('./CanvasAnnotationLayer.tsx');
  assert.match(layer, /pointerEvents="visibleStroke"/);
  assert.match(layer, /pointerEvents="visiblePainted"/);
  assert.match(layer, /<g pointerEvents="all">/);
});

test('canceling an annotation edit restores its captured geometry', () => {
  const drawing = source('./useCanvasDrawing.ts');
  assert.match(
    drawing,
    /if \(edit\) \{\s*studioDispatch\(\{ type: 'UPDATE_ANNOTATION', id: edit\.id, annotation: edit\.original \}\);/,
  );
});

test('canvas keyboard and paste handlers yield to interactive composer controls', () => {
  const canvas = source('./StudioCanvas.tsx');
  const images = source('./useCanvasImageImport.ts');
  assert.match(canvas, /!isStudioInteractiveTarget\(e\.target\)/);
  assert.match(images, /if \(isStudioTypingTarget\(event\.target\)\) return;/);
});

test('canvas image imports reserve capacity before asynchronous reads', () => {
  const images = source('./useCanvasImageImport.ts');
  assert.match(images, /imageCountRef\.current \+ reservedSlotsRef\.current/);
  assert.match(images, /reservedSlotsRef\.current \+= accepted\.length/);
  assert.match(images, /imageCountRef\.current \+= 1/);
  assert.match(images, /reservedSlotsRef\.current = Math\.max\(0, reservedSlotsRef\.current - 1\)/);
});

test('native Studio frames navigate regenerated URLs without mounting a duplicate iframe', () => {
  const frame = source('./StudioFrameBody.tsx');
  assert.match(
    frame,
    /openNativeBrowser\(\s*nativeBrowserSessionId,\s*frame\.url,\s*bounds,\s*undefined,\s*canvasZoomRef\.current/,
  );
  assert.match(frame, /if \(nativeNavigationRef\.current\) return;/);
  assert.match(frame, /nativeNavigationRef\.current = false;\s*return;/);
  assert.match(frame, /onNativeBrowserLoaded[\s\S]*?clearTimeout\(timerRef\.current\)/);
  assert.match(frame, /onNativeBrowserLoadFailed[\s\S]*?clearTimeout\(timerRef\.current\)/);
  assert.match(frame, /frame\.status === 'failed'\) return;[\s\S]*?detachNativeBrowser/);
  assert.match(frame, /hasUrl && native && interacting/);
  assert.match(frame, /frame\.status === 'failed' \|\| \(interacting && !native\)/);

  const chrome = source('./StudioFrameChrome.tsx');
  assert.match(chrome, /frame\.status !== 'failed'/);
});

test('direct canvas controls cancel frame-focus animation before changing view', () => {
  const controls = source('./CanvasControls.tsx');
  assert.match(controls, /onViewMutation\(\);\s*studioDispatch\(\{ type: 'SET_VIEW'/);
});

test('design intake completion waits for session creation', () => {
  const agentPanel = source('./AgentPanel.tsx');
  const shelf = source('./DnaShelf.tsx');
  const interview = source('./DnaInterview.tsx');
  assert.match(agentPanel, /isCreating=\{isCreating\}/);
  assert.match(shelf, /completionDisabled=\{isCreating\}/);
  assert.match(interview, /disabled=\{last && completionDisabled\}/);
});

test('frame Open action uses the guarded external-link command', () => {
  const panel = source('./SelectionContextPanel.tsx');
  assert.match(panel, /void openExternal\(frame\.url\)/);
  assert.doesNotMatch(panel, /window\.open\(frame\.url/);
});
