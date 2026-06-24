import test from 'node:test';
import assert from 'node:assert/strict';
import { compactsAtMarker } from './contextMeter';

test('per-model override wins over the global default', () => {
  assert.equal(
    compactsAtMarker('model-x', undefined, { 'model-x': 150_000 }, 90_000, undefined),
    150_000,
  );
});

test('falls back to the global default when the model has no override', () => {
  assert.equal(compactsAtMarker('model-x', undefined, {}, 90_000, undefined), 90_000);
});

test('resolves the orchestrator default model when the mission is reset to Default', () => {
  // Regression guard for #18: a reset-to-Default mission has no modelId, but the
  // session still runs the default model whose per-model trigger the daemon
  // honors, so the marker must follow that default model's override.
  assert.equal(
    compactsAtMarker(undefined, 'default-model', { 'default-model': 120_000 }, 80_000, undefined),
    120_000,
  );
});

test('an explicit mission model takes precedence over the orchestrator default', () => {
  assert.equal(
    compactsAtMarker(
      'model-x',
      'default-model',
      { 'model-x': 150_000, 'default-model': 120_000 },
      undefined,
      undefined,
    ),
    150_000,
  );
});

test('caps the trigger to the model context window', () => {
  assert.equal(
    compactsAtMarker('model-x', undefined, { 'model-x': 150_000 }, undefined, 100_000),
    100_000,
  );
});

test('hides the marker when no limit is configured', () => {
  assert.equal(compactsAtMarker(undefined, undefined, {}, undefined, 100_000), undefined);
  assert.equal(compactsAtMarker('model-x', 'default-model', {}, 0, 100_000), undefined);
});
