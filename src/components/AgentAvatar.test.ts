import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAvatar } from './AgentAvatar';

const render = (props: { seed: string; working?: boolean }) =>
  renderToStaticMarkup(createElement(AgentAvatar, props));

test('the same seed always produces the same creature', () => {
  assert.equal(render({ seed: 'child-1' }), render({ seed: 'child-1' }));
});

test('different seeds produce different creatures', () => {
  assert.notEqual(render({ seed: 'child-1' }), render({ seed: 'child-2' }));
});

test('every creature has enough lit pixels to read as a shape', () => {
  for (let i = 1; i <= 30; i += 1) {
    const rects = render({ seed: `child-${i}` }).match(/<rect/g) ?? [];
    assert.ok(rects.length >= 4, `seed child-${i} lit only ${rects.length} pixels`);
  }
});

test('only a working agent gets the shimmer sweep', () => {
  const working = render({ seed: 'child-1', working: true });
  assert.match(working, /agent-avatar-pixel/);
  assert.match(working, /animation-delay/);
  assert.doesNotMatch(render({ seed: 'child-1' }), /agent-avatar-pixel/);
});
