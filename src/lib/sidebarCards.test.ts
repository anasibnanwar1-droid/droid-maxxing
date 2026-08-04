import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissSidebarCard, loadSidebarCardSeen } from './sidebarCards';

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
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: mock,
  });
  try {
    fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

test('an unseen card reports not seen so it can show on launch', () => {
  withLocalStorageMap({}, () => {
    assert.equal(loadSidebarCardSeen('welcome-to-droidex'), false);
  });
});

test('dismissing a card persists the seen flag for that card id', () => {
  withLocalStorageMap({}, () => {
    dismissSidebarCard('welcome-to-droidex');
    assert.equal(loadSidebarCardSeen('welcome-to-droidex'), true);
  });
});

test('dismissal is scoped per card id so a new announcement still shows', () => {
  withLocalStorageMap({}, () => {
    dismissSidebarCard('welcome-to-droidex');
    assert.equal(loadSidebarCardSeen('update-2-notes'), false);
  });
});

test('storage failures stay quiet and report seen', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    },
  });
  try {
    assert.equal(loadSidebarCardSeen('welcome-to-droidex'), true);
    dismissSidebarCard('welcome-to-droidex');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
