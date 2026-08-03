import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTONOMY_DESCRIPTIONS,
  AUTONOMY_LABELS,
  AUTONOMY_LEVELS,
  FIRST_RUN_DEFAULT_AUTONOMY,
  loadDefaultAutonomy,
  missionStartAllowed,
  normalizeAutonomy,
  saveDefaultAutonomy,
} from './autonomy';

test('normalizeAutonomy accepts only the four canonical levels', () => {
  assert.deepEqual(AUTONOMY_LEVELS, ['off', 'low', 'medium', 'high']);
  for (const level of AUTONOMY_LEVELS) assert.equal(normalizeAutonomy(level), level);
  assert.equal(normalizeAutonomy('MAX'), undefined);
  assert.equal(normalizeAutonomy(''), undefined);
  assert.equal(normalizeAutonomy(undefined), undefined);
  assert.equal(normalizeAutonomy(42), undefined);
});

test('every level has a label and a consequence description', () => {
  for (const level of AUTONOMY_LEVELS) {
    assert.ok(AUTONOMY_LABELS[level].length > 0, `label for ${level}`);
    assert.ok(AUTONOMY_DESCRIPTIONS[level].length > 0, `description for ${level}`);
  }
});

test('first run defaults to medium and persisted values round-trip', () => {
  withLocalStorageMap({}, () => {
    assert.equal(loadDefaultAutonomy(), FIRST_RUN_DEFAULT_AUTONOMY);
    assert.equal(FIRST_RUN_DEFAULT_AUTONOMY, 'medium');
    saveDefaultAutonomy('low');
    assert.equal(loadDefaultAutonomy(), 'low');
  });
});

test('a corrupt persisted value falls back to the first-run default', () => {
  withLocalStorageMap({ 'droid-default-autonomy': 'yolo' }, () => {
    assert.equal(loadDefaultAutonomy(), FIRST_RUN_DEFAULT_AUTONOMY);
  });
});

test('only high autonomy allows a mission to start', () => {
  assert.equal(missionStartAllowed('high'), true);
  assert.equal(missionStartAllowed('medium'), false);
  assert.equal(missionStartAllowed('low'), false);
  assert.equal(missionStartAllowed('off'), false);
});

function withLocalStorageMap(seed: Record<string, string>, fn: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map(Object.entries(seed));
  const mock: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, next) => {
      values.set(key, next);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: mock });
  try {
    fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}
