import assert from 'node:assert/strict';
import test from 'node:test';
import { editorLabel, normalizeEditorId } from './editorOpen';

test('normalizeEditorId keeps known editors and falls back to VS Code', () => {
  assert.equal(normalizeEditorId('cursor'), 'cursor');
  assert.equal(normalizeEditorId('unknown'), 'vscode');
});

test('editorLabel names the selected editor', () => {
  assert.equal(editorLabel('xcode'), 'Xcode');
  assert.equal(editorLabel('bad'), 'VS Code');
});
