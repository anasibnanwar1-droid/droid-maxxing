import assert from 'node:assert/strict';
import test from 'node:test';
import { renderBrandBook } from './brandBook.js';
import type { DesignTokens } from './types.js';

const tokens: DesignTokens = {
  colors: {
    brand: '#e0653a',
    surface: '#ffffff',
    text: '#111111',
    muted: '#666666',
    border: '#e5e5e5',
  },
  fonts: {
    sans: '"Inter", sans-serif',
    mono: '"JetBrains Mono", monospace',
    display: '"Playfair Display", serif',
  },
  typeScale: [14, 16, 20, 32, 48],
  spacing: [4, 8, 16, 24],
  radii: [0, 8, 16],
};

const designMd = [
  '# Acme',
  '',
  'A precise financial tool.',
  '',
  '## Brand Strategy',
  '',
  '- Confident and clear.',
  '',
  '## Tokens',
  '',
  '```design-tokens',
  '{"colors":{}}',
  '```',
].join('\n');

const motionMd = '# Motion\n\n## Easing\n\n- Standard curve.';

test('renderBrandBook themes the page in the DNA tokens', () => {
  const html = renderBrandBook({ cwd: '/tmp/acme-app', tokens, designMd, motionMd });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /--brand:#e0653a/);
  assert.match(html, /--surface:#ffffff/);
  assert.match(html, /Playfair Display/); // the display font drives the page
  assert.match(html, /#E0653A/); // swatch hex, uppercased
});

test('renderBrandBook uses the real brand name, prose, and type scale', () => {
  const html = renderBrandBook({ cwd: '/tmp/acme-app', tokens, designMd, motionMd });
  assert.match(html, /Acme/); // brand name from the H1
  assert.match(html, /Brand Strategy/); // prose section rendered
  assert.match(html, /48px/); // top of the type scale in the ladder
});

test('renderBrandBook strips the token block and is deterministic', () => {
  const a = renderBrandBook({ cwd: '/tmp/acme-app', tokens, designMd, motionMd });
  const b = renderBrandBook({ cwd: '/tmp/acme-app', tokens, designMd, motionMd });
  assert.equal(a, b); // no wall-clock / randomness
  assert.doesNotMatch(a, /design-tokens/); // fenced token block never shown
});

test('renderBrandBook neutralizes hostile token values (no CSS/HTML breakout)', () => {
  const evil: DesignTokens = {
    colors: { brand: 'red" onload="alert(1)', surface: '#ffffff', text: '#000000' },
    fonts: { sans: 'Inter; } body { background: red' },
    typeScale: [16],
    spacing: [8],
    radii: [4],
  };
  const html = renderBrandBook({
    cwd: '/tmp/x',
    tokens: evil,
    designMd: '# X\n\n<script>alert(1)</script>',
    motionMd: '',
  });
  assert.doesNotMatch(html, /onload=/);
  assert.doesNotMatch(html, /} body {/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('renderBrandBook falls back to the cwd name when the DNA has no title', () => {
  const html = renderBrandBook({
    cwd: '/tmp/my-cool-project',
    tokens,
    designMd: '# Design DNA\n\nsome prose',
    motionMd: '',
  });
  assert.match(html, /My Cool Project/);
});
