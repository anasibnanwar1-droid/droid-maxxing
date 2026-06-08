export const EDITOR_OPTIONS = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'finder', label: 'Finder' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'xcode', label: 'Xcode' },
] as const;

export type EditorId = typeof EDITOR_OPTIONS[number]['id'];
export type EditorTarget = 'codebase' | 'diff';

export const DEFAULT_EDITOR_STORAGE_KEY = 'droid-default-editor';
const DEFAULT_EDITOR: EditorId = 'vscode';

export function normalizeEditorId(value: unknown): EditorId {
  return EDITOR_OPTIONS.some((option) => option.id === value) ? value as EditorId : DEFAULT_EDITOR;
}

export function editorLabel(value: unknown): string {
  const id = normalizeEditorId(value);
  return EDITOR_OPTIONS.find((option) => option.id === id)?.label ?? 'VS Code';
}

export function getDefaultEditor(): EditorId {
  if (typeof localStorage === 'undefined') return DEFAULT_EDITOR;
  return normalizeEditorId(localStorage.getItem(DEFAULT_EDITOR_STORAGE_KEY));
}

export function setDefaultEditor(editor: EditorId): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(DEFAULT_EDITOR_STORAGE_KEY, editor);
}
