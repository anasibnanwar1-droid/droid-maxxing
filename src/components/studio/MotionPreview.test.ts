import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveMotionColors,
  resolveMotionPreview,
  resolveMotionTargets,
  resolveReducedMotion,
} from './MotionPreview';

test('motion preview uses the project duration, easing, and press scale', () => {
  assert.deepEqual(
    resolveMotionPreview({
      durations: { micro: [120, 160], element: [200, 260] },
      easings: { standard: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      pressScale: 0.97,
      reducedMotion: 'reduce',
    }),
    {
      durationMs: 230,
      durationLabel: '200–260ms',
      ease: [0.16, 1, 0.3, 1],
      easingLabel: 'cubic-bezier(0.16, 1, 0.3, 1)',
      pressScale: 0.97,
    },
  );
});

test('motion preview respects preferred semantic color order over palette insertion order', () => {
  assert.deepEqual(
    resolveMotionColors({ primaryText: '#111111', primary: '#2255ff', accent: '#ff5500' }),
    {
      accent: '#ff5500',
      surface: 'var(--droid-surface)',
      text: '#111111',
    },
  );
});

test('motion preview falls back to the first declared duration', () => {
  assert.equal(
    resolveMotionPreview({
      durations: { page: 320 },
      easings: { enter: 'ease-out' },
      reducedMotion: 'reduce',
    }).durationMs,
    320,
  );
});

test('reduced-motion policies remain distinct', () => {
  assert.equal(resolveReducedMotion(true, 'disable'), 'disabled');
  assert.equal(resolveReducedMotion(true, 'reduce'), 'reduced');
  assert.equal(resolveReducedMotion(false, 'disable'), 'full');
  assert.deepEqual(resolveMotionTargets('disabled', 0.96), { press: {}, lift: {}, enterY: 0 });
  assert.deepEqual(resolveMotionTargets('reduced', 0.96), {
    press: { opacity: 0.72 },
    lift: { opacity: 0.72 },
    enterY: 0,
  });
});
