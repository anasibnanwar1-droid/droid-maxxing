import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDelimitedText } from '../../lib/filePreview';

test('delimited previews discard columns beyond the visible column limit', () => {
  const firstRow = Array.from({ length: 60 }, (_, index) => `value${index + 1}`).join(',');
  const rows = parseDelimitedText(`${firstRow}\nnext,row`, ',', 500, 50);

  assert.equal(rows[0].length, 50);
  assert.equal(rows[0][49], 'value50');
  assert.deepEqual(rows[1], ['next', 'row']);
});
