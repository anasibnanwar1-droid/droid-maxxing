import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown';

test('disabled diagrams render fenced SVG as escaped code', () => {
  const source = '```svg\n<svg onload="globalThis.pwned=true"></svg>\n```';
  const html = renderToStaticMarkup(createElement(Markdown, { allowDiagrams: false }, source));

  assert.doesNotMatch(html, /<svg[\s>]/i);
  assert.match(html, /&lt;svg onload=/);
});
