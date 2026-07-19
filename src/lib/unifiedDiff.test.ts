import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, toSplitRows } from './unifiedDiff';

const SAMPLE = [
  'diff --git a/f.txt b/f.txt',
  'index 111..222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,3 +1,4 @@',
  ' keep',
  '-old line',
  '+new line',
  '+added line',
  ' tail',
  '\\ No newline at end of file',
].join('\n');

test('parseUnifiedDiff counts and numbers lines', () => {
  const parsed = parseUnifiedDiff(SAMPLE);
  assert.equal(parsed.binary, false);
  assert.equal(parsed.additions, 2);
  assert.equal(parsed.deletions, 1);
  assert.equal(parsed.hunks.length, 1);
  const lines = parsed.hunks[0].lines;
  const firstCtx = lines.find((l) => l.type === 'ctx');
  assert.equal(firstCtx?.oldLine, 1);
  assert.equal(firstCtx?.newLine, 1);
  const add = lines.find((l) => l.type === 'add');
  assert.equal(add?.oldLine, null);
  assert.equal(typeof add?.newLine, 'number');
});

test('parseUnifiedDiff ignores the trailing-newline artifact', () => {
  const diff = ['@@ -1,2 +1,2 @@', ' keep', '-old', '+new', ''].join('\n');
  const parsed = parseUnifiedDiff(diff);
  const lines = parsed.hunks[0].lines;
  // keep(ctx), old(del), new(add) — no phantom blank ctx row from the final ''.
  assert.equal(lines.length, 3);
  assert.equal(lines[lines.length - 1].type, 'add');
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.deletions, 1);
});

test('toSplitRows context after an insertion carries divergent old/new numbers', () => {
  const diff = ['@@ -1,2 +1,3 @@', ' a', '+inserted', ' b'].join('\n');
  const parsed = parseUnifiedDiff(diff);
  const rows = toSplitRows(parsed.hunks[0].lines);
  const tail = rows[rows.length - 1];
  // Context line 'b' is old line 2 but new line 3; the split view's right pane
  // must render newLine (3), not oldLine (2).
  assert.equal(tail.left?.oldLine, 2);
  assert.equal(tail.right?.newLine, 3);
  assert.notEqual(tail.left?.oldLine, tail.right?.newLine);
});

test('toSplitRows pairs a no-newline replacement across meta markers', () => {
  const diff = [
    '@@ -1 +1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
  ].join('\n');
  const parsed = parseUnifiedDiff(diff);
  const rows = toSplitRows(parsed.hunks[0].lines);
  const paired = rows.find((r) => r.left?.type === 'del' && r.right?.type === 'add');
  assert.ok(paired, 'the replacement should sit on a single paired row');
  assert.equal(paired?.left?.text, 'old');
  assert.equal(paired?.right?.text, 'new');
  // The old-file marker lands in the left column and the new-file marker in
  // the right column, on the same row.
  const metaRow = rows.find((r) => r.left?.type === 'meta' || r.right?.type === 'meta');
  assert.equal(metaRow?.left?.type, 'meta');
  assert.equal(metaRow?.right?.type, 'meta');
});

test('parseUnifiedDiff flags binary patches', () => {
  const parsed = parseUnifiedDiff('Binary files a/x.png and b/x.png differ');
  assert.equal(parsed.binary, true);
  assert.equal(parsed.hunks.length, 0);
});

test('toSplitRows pairs deletions with additions', () => {
  const parsed = parseUnifiedDiff(SAMPLE);
  const rows = toSplitRows(parsed.hunks[0].lines);
  // ctx "keep", paired del/add, lone add, ctx "tail", trailing meta marker
  assert.equal(rows[0].left?.type, 'ctx');
  assert.equal(rows[1].left?.type, 'del');
  assert.equal(rows[1].right?.type, 'add');
  assert.equal(rows[2].left, null);
  assert.equal(rows[2].right?.type, 'add');
  assert.equal(rows[rows.length - 2].right?.type, 'ctx');
});

test('toSplitRows applies a post-context meta marker to both panes', () => {
  const parsed = parseUnifiedDiff(SAMPLE);
  const rows = toSplitRows(parsed.hunks[0].lines);
  const meta = rows.find((r) => r.left?.type === 'meta');
  assert.ok(meta, 'meta row should be kept in split view');
  // After a shared context line, the missing newline describes both files.
  assert.equal(meta?.right, meta?.left);
  assert.match(meta?.left?.text ?? '', /No newline at end of file/);
});
