import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitJsonRender, hasJsonRender, __resolveColorForTest as resolveColor } from './JsonRender';

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

test('keeps completed prose that merely mentions the json-render tag', () => {
  const text = 'Use <json-render> tags to render rich UI in the terminal.';
  assert.deepEqual(splitJsonRender(text), [{ type: 'markdown', value: text }]);
});

test('keeps prose mentioning the tag after a completed block', () => {
  const segs = splitJsonRender('<json-render>{"a":1}</json-render>\nEmit a <json-render> block to draw charts.');
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { type: 'json-render', value: '{"a":1}' });
  assert.deepEqual(segs[1], { type: 'markdown', value: '\nEmit a <json-render> block to draw charts.' });
});

test('hasJsonRender detects the opening tag', () => {
  assert.equal(hasJsonRender('x <json-render>{}</json-render>'), true);
  assert.equal(hasJsonRender('no tags here'), false);
});

test('resolveColor maps themed names and accepts safe literals', () => {
  assert.equal(resolveColor('green'), 'var(--droid-green)');
  assert.equal(resolveColor('#ff8800'), '#ff8800');
  assert.equal(resolveColor('rgb(10, 20, 30)'), 'rgb(10, 20, 30)');
  assert.equal(resolveColor('red'), '#d0584e');
  assert.equal(resolveColor('teal'), 'teal');
});

test('resolveColor rejects CSS function injection', () => {
  assert.equal(resolveColor('url(https://evil.example/x.png)'), undefined);
  assert.equal(resolveColor('var(--secret)'), undefined);
  assert.equal(resolveColor('red;background:url(http://x)'), undefined);
  assert.equal(resolveColor(123), undefined);
});
