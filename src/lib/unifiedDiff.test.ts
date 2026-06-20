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

test('parseUnifiedDiff flags binary patches', () => {
  const parsed = parseUnifiedDiff('Binary files a/x.png and b/x.png differ');
  assert.equal(parsed.binary, true);
  assert.equal(parsed.hunks.length, 0);
});

test('toSplitRows pairs deletions with additions', () => {
  const parsed = parseUnifiedDiff(SAMPLE);
  const rows = toSplitRows(parsed.hunks[0].lines);
  // ctx "keep", paired del/add, lone add, ctx "tail"
  assert.equal(rows[0].left?.type, 'ctx');
  assert.equal(rows[1].left?.type, 'del');
  assert.equal(rows[1].right?.type, 'add');
  assert.equal(rows[2].left, null);
  assert.equal(rows[2].right?.type, 'add');
  assert.equal(rows[rows.length - 1].right?.type, 'ctx');
});
