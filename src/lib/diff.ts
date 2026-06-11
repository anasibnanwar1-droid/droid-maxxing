export type DiffOpType = 'add' | 'del' | 'ctx';
export interface DiffOp {
  type: DiffOpType;
  text: string;
}
export interface FileChange {
  path: string;
  verb: 'edit' | 'create' | 'patch';
  ops: DiffOp[];
  added: number;
  removed: number;
}

const EDIT_TOOLS = ['edit', 'multiedit', 'multi_edit', 'str_replace', 'apply_patch', 'create', 'write'];

function isEditTool(name: string): boolean {
  return EDIT_TOOLS.some((t) => name === t) || name.includes('edit') || name.includes('patch') || name.includes('write') || name.includes('str_replace');
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

// Line-level LCS diff. Guarded against very large inputs.
function lineDiff(oldStr: string, newStr: string): DiffOp[] {
  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) {
    return [
      ...a.map((t) => ({ type: 'del' as const, text: t })),
      ...b.map((t) => ({ type: 'add' as const, text: t })),
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i++; }
    else { ops.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

// apply_patch / unified-diff bodies carry the file path in their header lines
// (`*** Update File: x`, `+++ b/x`), which the arg keys don't expose. Recover it
// so edits show the real filename instead of the generic "file" fallback.
function pathFromPatch(patch: string): string | undefined {
  // Prefer the new-file path (`+++ b/x`); fall back to the old-file path
  // (`--- a/x`) for delete-only diffs where the new side is `/dev/null`.
  let fromOld: string | undefined;
  for (const line of patch.split('\n')) {
    const star = line.match(/^\*\*\* (?:Update|Add|Delete|Move to) File:\s*(.+?)\s*$/);
    if (star) return star[1];
    const plus = line.match(/^\+\+\+ (?:[ab]\/)?(.+?)\s*$/);
    if (plus && plus[1] !== '/dev/null') return plus[1];
    const minus = line.match(/^--- (?:[ab]\/)?(.+?)\s*$/);
    if (minus && minus[1] !== '/dev/null' && fromOld === undefined) fromOld = minus[1];
  }
  return fromOld;
}

function parsePatch(patch: string): DiffOp[] {
  const ops: DiffOp[] = [];
  for (const line of patch.split('\n')) {
    if (
      line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') ||
      line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('*** ')
    ) continue;
    if (line.startsWith('+')) ops.push({ type: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) ops.push({ type: 'del', text: line.slice(1) });
    else ops.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
  }
  return ops;
}

export function extractFileChange(toolName?: string, args?: unknown): FileChange | null {
  if (!toolName) return null;
  if (!isEditTool(toolName.toLowerCase())) return null;

  const a: Record<string, unknown> = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const argPath = firstString(a, ['path', 'file_path', 'filePath', 'file', 'target_file', 'filename']);

  const patch = firstString(a, ['patch', 'diff', 'input']) ?? (typeof args === 'string' ? args : undefined);
  if (patch && /(^|\n)[+-]/.test(patch)) {
    const ops = parsePatch(patch);
    return finalize(argPath ?? pathFromPatch(patch) ?? 'file', 'patch', ops);
  }

  const path = argPath ?? 'file';

  if (Array.isArray(a.edits)) {
    const ops: DiffOp[] = [];
    for (const e of a.edits as Record<string, unknown>[]) {
      const o = firstString(e, ['old_string', 'old_str', 'oldText', 'old']) ?? '';
      const nw = firstString(e, ['new_string', 'new_str', 'newText', 'new']) ?? '';
      ops.push(...lineDiff(o, nw));
    }
    return finalize(path, 'edit', ops);
  }

  const oldS = firstString(a, ['old_string', 'old_str', 'oldText', 'old']);
  const newS = firstString(a, ['new_string', 'new_str', 'newText', 'new']);
  if (oldS !== undefined || newS !== undefined) return finalize(path, 'edit', lineDiff(oldS ?? '', newS ?? ''));

  const content = firstString(a, ['content', 'contents', 'text']);
  if (content !== undefined) return finalize(path, 'create', content.split('\n').map((t) => ({ type: 'add' as const, text: t })));

  return null;
}

function finalize(path: string, verb: FileChange['verb'], ops: DiffOp[]): FileChange | null {
  const added = ops.filter((o) => o.type === 'add').length;
  const removed = ops.filter((o) => o.type === 'del').length;
  if (added === 0 && removed === 0) return null;
  return { path, verb, ops, added, removed };
}
