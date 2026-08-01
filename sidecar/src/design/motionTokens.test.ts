import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMotionTokens, serializeMotionTokenBlock } from './motionTokens.js';

const tokens = {
  durations: { micro: [120, 160] as [number, number], element: 240 },
  easings: { standard: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  pressScale: 0.97,
  reducedMotion: 'reduce' as const,
};

test('parseMotionTokens reads the executable MOTION.md contract', () => {
  const parsed = parseMotionTokens(`# Motion\n\n${serializeMotionTokenBlock(tokens)}\n`);
  assert.deepEqual(parsed, tokens);
});

test('parseMotionTokens rejects prose-only and incomplete blocks', () => {
  assert.equal(parseMotionTokens('# Motion\n\n- quick and calm'), undefined);
  assert.equal(
    parseMotionTokens(
      '```motion-tokens\n{"durations":{"micro":120},"easings":{},"reducedMotion":"reduce"}\n```',
    ),
    undefined,
  );
});

test('parseMotionTokens drops unsafe optional values and invalid duration entries', () => {
  const parsed = parseMotionTokens(
    '```motion-tokens\n{"durations":{"micro":[160,120],"element":240},"easings":{"standard":"ease-out"},"pressScale":2,"reducedMotion":"disable"}\n```',
  );
  assert.deepEqual(parsed, {
    durations: { element: 240 },
    easings: { standard: 'ease-out' },
    reducedMotion: 'disable',
  });
});

test('parseMotionTokens rejects CSS-breaking easing values', () => {
  assert.equal(
    parseMotionTokens(
      '```motion-tokens\n{"durations":{"micro":120},"easings":{"standard":"linear; color:red"},"reducedMotion":"reduce"}\n```',
    ),
    undefined,
  );
});

test('parseMotionTokens rejects easing forms the live preview cannot reproduce', () => {
  assert.equal(
    parseMotionTokens(
      '```motion-tokens\n{"durations":{"micro":120},"easings":{"standard":"steps(4, end)"},"reducedMotion":"reduce"}\n```',
    ),
    undefined,
  );
});

test('parseMotionTokens rejects cubic bezier curves with invalid x coordinates', () => {
  assert.equal(
    parseMotionTokens(
      '```motion-tokens\n{"durations":{"micro":120},"easings":{"standard":"cubic-bezier(4, 0, -2, 1)"},"reducedMotion":"reduce"}\n```',
    ),
    undefined,
  );
});

test('parseMotionTokens normalizes easing whitespace and rejects non-finite coordinates', () => {
  const normalized = parseMotionTokens(
    '```motion-tokens\n{"durations":{"micro":120},"easings":{"standard":"  ease-out  "},"reducedMotion":"reduce"}\n```',
  );
  assert.equal(normalized?.easings.standard, 'ease-out');

  const huge = '9'.repeat(400);
  assert.equal(
    parseMotionTokens(
      `\`\`\`motion-tokens\n{"durations":{"micro":120},"easings":{"standard":"cubic-bezier(0.2, ${huge}, 0.8, 1)"},"reducedMotion":"reduce"}\n\`\`\``,
    ),
    undefined,
  );
});
