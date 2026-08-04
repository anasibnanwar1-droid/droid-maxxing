import assert from 'node:assert/strict';
import test from 'node:test';
import { renderBrandBook } from './brandBook.js';
import { serializeMotionTokenBlock } from './motionTokens.js';
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

test('renderBrandBook measures named, HSL, and translucent swatches as rendered', () => {
  const html = renderBrandBook({
    cwd: '/tmp/colors',
    tokens: {
      ...tokens,
      colors: {
        surface: '#ffffff',
        named: 'rebeccapurple',
        hsl: 'hsl(0 100% 50%)',
        overlay: '#00000080',
      },
    },
    designMd,
    motionMd,
  });
  assert.match(html, /background:rebeccapurple/);
  assert.match(html, /background:hsl\(0 100% 50%\)/);
  assert.match(html, /AA on #000000 · 5\.3:1/);
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

test('renderBrandBook plays the executable MOTION.md values instead of defaults', () => {
  const html = renderBrandBook({
    cwd: '/tmp/acme-app',
    tokens,
    designMd,
    motionMd: `# Motion\n\n${serializeMotionTokenBlock({
      durations: { element: [180, 220] },
      easings: { standard: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      pressScale: 0.94,
      reducedMotion: 'reduce',
    })}`,
  });
  assert.match(html, /--demo-duration:200ms/);
  assert.match(html, /--demo-ease:cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/);
  assert.match(html, /--press-scale:0\.94/);
  assert.doesNotMatch(html, /\.32s cubic-bezier/);
  assert.doesNotMatch(html, /```motion-tokens/);
});

test('renderBrandBook does not invent motion for prose-only MOTION.md', () => {
  const html = renderBrandBook({ cwd: '/tmp/acme-app', tokens, designMd, motionMd });
  assert.match(html, /Motion is documented, but not executable yet/);
  assert.doesNotMatch(html, /type="button" class="motion-demo-card"/);
});

test('renderBrandBook previews a page-only duration and preserves reduced policy', () => {
  const html = renderBrandBook({
    cwd: '/tmp/acme-app',
    tokens,
    designMd,
    motionMd: serializeMotionTokenBlock({
      durations: { page: 320 },
      easings: { enter: 'ease-out' },
      reducedMotion: 'reduce',
    }),
  });

  assert.match(html, /--demo-duration:320ms/);
  assert.match(html, /motion-stage motion-reduce/);
  assert.match(html, /\.motion-reduce \.motion-demo-card:hover/);
});

test('renderBrandBook makes every duration and easing token playable', () => {
  const html = renderBrandBook({
    cwd: '/tmp/acme-app',
    tokens,
    designMd,
    motionMd: serializeMotionTokenBlock({
      durations: { micro: 120, element: 220, page: 360 },
      easings: { standard: 'ease-out', exit: 'ease-in' },
      reducedMotion: 'disable',
    }),
  });

  for (const token of [
    'duration:micro',
    'duration:element',
    'duration:page',
    'easing:standard',
    'easing:exit',
  ]) {
    assert.match(html, new RegExp(`data-motion-token="${token}"`));
  }
});
