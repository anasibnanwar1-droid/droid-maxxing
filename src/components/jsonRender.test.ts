import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitJsonRender, hasJsonRender } from './JsonRender';

test('plain text yields a single markdown segment', () => {
  const segs = splitJsonRender('hello world');
  assert.deepEqual(segs, [{ type: 'markdown', value: 'hello world' }]);
});

test('interleaves markdown and json-render blocks', () => {
  const segs = splitJsonRender('before <json-render>{"a":1}</json-render> after');
  assert.equal(segs.length, 3);
  assert.equal(segs[0].type, 'markdown');
  assert.deepEqual(segs[1], { type: 'json-render', value: '{"a":1}' });
  assert.equal(segs[2].type, 'markdown');
});

test('handles multiple json-render blocks', () => {
  const segs = splitJsonRender('<json-render>{"a":1}</json-render><json-render>{"b":2}</json-render>');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].type, 'json-render');
  assert.equal(segs[1].type, 'json-render');
});

test('hides a still-streaming (unclosed) json-render block', () => {
  const segs = splitJsonRender('done\n<json-render>{"partial": ');
  assert.deepEqual(segs, [{ type: 'markdown', value: 'done\n' }]);
});

test('hasJsonRender detects the opening tag', () => {
  assert.equal(hasJsonRender('x <json-render>{}</json-render>'), true);
  assert.equal(hasJsonRender('no tags here'), false);
});
