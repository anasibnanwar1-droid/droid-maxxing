import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveReasoningEffortDisplay } from './reasoningEffort';

test('session-pinned effort wins over the global default', () => {
  assert.equal(
    resolveReasoningEffortDisplay('low', 'high', { supportedReasoningEfforts: ['low', 'high'] }),
    'low',
  );
});

test('falls back to the global default when the session pins no effort', () => {
  assert.equal(
    resolveReasoningEffortDisplay(undefined, 'high', { supportedReasoningEfforts: ['high'] }),
    'high',
  );
});

test('hides the indicator for a known model without supported reasoning efforts', () => {
  assert.equal(
    resolveReasoningEffortDisplay('high', 'low', { supportedReasoningEfforts: [] }),
    undefined,
  );
  // A known model whose capability list is absent counts as no support.
  assert.equal(resolveReasoningEffortDisplay(undefined, 'high', {}), undefined);
});

test('keeps the indicator while the model is unknown (list still loading)', () => {
  assert.equal(resolveReasoningEffortDisplay('low', 'high', undefined), 'low');
});

test('hides the indicator when neither session nor global effort exists', () => {
  assert.equal(resolveReasoningEffortDisplay(undefined, undefined, undefined), undefined);
});
