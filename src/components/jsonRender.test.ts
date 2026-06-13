import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  JsonRender,
  splitJsonRender,
  hasJsonRender,
  __resolveColorForTest as resolveColor,
  __renderBudgetForTest as renderBudget,
  __MAX_NODES_FOR_TEST as MAX_NODES,
  __statusMetaForTest as statusMeta,
} from './JsonRender';

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

test('render budget caps an exponential shared-child DAG', () => {
  // Each level points twice at the next distinct id: a -> [b,b], b -> [c,c]...
  // `seen` only blocks per-path cycles, so without a global budget this fans out
  // to ~2^40 nodes and freezes. The budget must keep it bounded (and finish).
  const levels = 40;
  const elements: Record<string, unknown> = {};
  for (let i = 0; i < levels; i++) {
    const next = `n${i + 1}`;
    elements[`n${i}`] = { type: 'Box', children: [next, next] };
  }
  elements[`n${levels}`] = { type: 'Text', props: { text: 'leaf' } };
  const count = renderBudget({ root: 'n0', elements });
  assert.ok(count <= MAX_NODES, `expanded ${count} nodes, expected <= ${MAX_NODES}`);
});

test('statusMeta resolves real statuses and falls back for prototype keys', () => {
  assert.ok(statusMeta('success').Icon, 'known status keeps its icon');
  // A model-supplied prototype key must not resolve through Object.prototype to
  // a meta without an Icon (which would crash React rendering <undefined />).
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const meta = statusMeta(key);
    assert.ok(meta && meta.Icon, `${key} falls back to a meta with an icon`);
    assert.equal(meta.color, statusMeta('info').color);
  }
});

test('a huge Sparkline data array renders without blowing the call stack', () => {
  // Before the collection cap, SparklineEl's `Math.min(...data)` spread on a
  // 200k-element array threw RangeError and froze the chat. The cap must keep
  // the spec renderable.
  const data = Array.from({ length: 200_000 }, (_, i) => i % 50);
  const source = JSON.stringify({ root: 'r', elements: { r: { type: 'Sparkline', props: { data } } } });
  assert.doesNotThrow(() => renderToStaticMarkup(createElement(JsonRender, { source })));
});

test('a huge BarChart data array renders without blowing the call stack', () => {
  const data = Array.from({ length: 200_000 }, (_, i) => ({ label: `l${i}`, value: i % 50 }));
  const source = JSON.stringify({ root: 'r', elements: { r: { type: 'BarChart', props: { data } } } });
  assert.doesNotThrow(() => renderToStaticMarkup(createElement(JsonRender, { source })));
});

test('render budget leaves small specs fully expanded', () => {
  const count = renderBudget({
    root: 'r',
    elements: {
      r: { type: 'Box', children: ['a', 'b'] },
      a: { type: 'Text', props: { text: 'a' } },
      b: { type: 'Text', props: { text: 'b' } },
    },
  });
  assert.equal(count, 3);
});
