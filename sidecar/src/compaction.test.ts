import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampCompactionTokenLimit,
  compactionTokenLimitForModel,
  compactionTriggerCeiling,
  daemonCompactionSettings,
  daemonDefaultCompactionTokenLimit,
  effectiveCompactionTriggerLimit,
  resolvedCompactionTokenLimit,
  resumedCompactionTokenLimit,
} from './compaction.js';

test('compaction limits prefer per-model settings and preserve Factory fallbacks', () => {
  assert.equal(
    compactionTokenLimitForModel(
      'model-b',
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-b': 800_000 } },
      { compactionTokenLimit: 100_000, compactionTokenLimitPerModel: { 'model-b': 300_000 } },
    ),
    800_000,
  );
  assert.equal(
    compactionTokenLimitForModel('model-a', {}, { compactionTokenLimit: 200_000 }),
    200_000,
  );
  assert.equal(
    effectiveCompactionTriggerLimit({
      modelId: 'model-a',
      ui: {
        compactionTokenLimit: 200_000,
        compactionTokenLimitPerModel: { 'model-a': 150_000 },
      },
    }),
    150_000,
  );
});

test('compaction thresholds leave model-window headroom and retain daemon defaults', () => {
  assert.equal(compactionTriggerCeiling(100_000), 80_000);
  assert.equal(compactionTriggerCeiling(undefined), undefined);
  assert.equal(compactionTriggerCeiling(1), 1);
  assert.equal(clampCompactionTokenLimit(200_000, 100_000), 80_000);
  assert.equal(clampCompactionTokenLimit(80_000, 200_000), 80_000);
  assert.equal(clampCompactionTokenLimit(200_000), 200_000);
  assert.equal(daemonDefaultCompactionTokenLimit(), 250_000);
  assert.equal(daemonDefaultCompactionTokenLimit(1_000_000), 250_000);
  assert.equal(daemonDefaultCompactionTokenLimit(180_000), 180_000);
  assert.equal(
    effectiveCompactionTriggerLimit({
      modelId: 'model-a',
      ui: { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
      maxContextTokens: 100_000,
    }),
    80_000,
  );
});

test('resume limits prefer exposed session settings before current defaults', () => {
  assert.equal(
    resumedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimit: 120_000 },
      { compactionTokenLimit: 200_000 },
    ),
    120_000,
  );
  assert.equal(
    resumedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimit: 120_000 },
      { compactionTokenLimitPerModel: { 'model-a': 200_000 } },
    ),
    120_000,
  );
  assert.equal(
    resumedCompactionTokenLimit(
      'model-a',
      {},
      { compactionTokenLimitPerModel: { 'model-a': 175_000 } },
    ),
    175_000,
  );
  assert.equal(
    resumedCompactionTokenLimit('model-a', {}, { compactionTokenLimit: 190_000 }),
    190_000,
  );
});

test('the UI snapshot outranks exposed and CLI compaction limits', () => {
  assert.equal(
    resolvedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-a': 120_000 } },
      { compactionTokenLimit: 400_000 },
      { compactionTokenLimit: 300_000 },
    ),
    120_000,
  );
  assert.equal(
    resolvedCompactionTokenLimit(
      'model-b',
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-a': 120_000 } },
      { compactionTokenLimit: 400_000 },
      { compactionTokenLimit: 300_000 },
    ),
    200_000,
  );
  assert.equal(
    resolvedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
      {},
      { compactionTokenLimit: 300_000, compactionTokenLimitPerModel: { 'model-a': 150_000 } },
    ),
    undefined,
  );
  assert.equal(
    resolvedCompactionTokenLimit(
      'model-a',
      { compactionTokenLimitPerModel: {} },
      { compactionTokenLimit: 210_000 },
      { compactionTokenLimit: 300_000, compactionTokenLimitPerModel: { 'model-a': 150_000 } },
    ),
    210_000,
  );
  assert.equal(
    resolvedCompactionTokenLimit('model-a', {}, { compactionTokenLimit: 400_000 }, {}),
    400_000,
  );
});

test('cleared UI limits still arm daemon auto-compaction', () => {
  assert.equal(
    effectiveCompactionTriggerLimit({
      modelId: 'model-a',
      ui: { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
    }),
    250_000,
  );
  assert.deepEqual(daemonCompactionSettings(120_000), {
    compactionThresholdCheckEnabled: true,
    compactionTokenLimit: 120_000,
  });
  assert.deepEqual(daemonCompactionSettings(undefined), {
    compactionThresholdCheckEnabled: true,
  });
});
