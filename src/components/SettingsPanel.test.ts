import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { initialState, reducer, StoreContext, type AppState } from '../hooks/useStore.js';
import type { AppIconMode } from '../lib/appIcon.js';
import { AppearanceSection } from './SettingsPanel.js';

const ICON_MODES: readonly [AppIconMode, string][] = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

function renderAppearance(appIconMode: AppIconMode): string {
  const state: AppState = {
    ...initialState,
    theme: { ...initialState.theme, appIconMode },
  };
  return renderToStaticMarkup(
    createElement(
      StoreContext.Provider,
      { value: { state, dispatch: () => undefined } },
      createElement(AppearanceSection),
    ),
  );
}

// The App icon selector shares Light/Dark/System labels with the Theme row, so
// scope every assertion to the group tagged `aria-label="App icon"`.
function iconGroup(html: string): string {
  const start = html.indexOf('aria-label="App icon"');
  assert.notEqual(start, -1, 'App icon selector group is missing');
  const end = html.indexOf('</div>', start);
  assert.notEqual(end, -1, 'App icon selector group is unterminated');
  return html.slice(start, end);
}

function optionFor(group: string, label: string): string {
  const segment = group.split('</button>').find((part) => part.includes(label));
  assert.ok(segment, `App icon option "${label}" is missing`);
  return segment;
}

for (const [mode, label] of ICON_MODES) {
  test(`app icon selector marks the persisted "${mode}" mode active`, () => {
    const group = iconGroup(renderAppearance(mode));
    for (const [, otherLabel] of ICON_MODES) {
      const option = optionFor(group, otherLabel);
      if (otherLabel === label) {
        assert.match(option, /aria-pressed="true"/, `${otherLabel} should be active for ${mode}`);
      } else {
        assert.match(
          option,
          /aria-pressed="false"/,
          `${otherLabel} should be inactive for ${mode}`,
        );
      }
    }
  });
}

test('selecting an app icon mode persists appIconMode through SET_THEME', () => {
  const values = new Map<string, string>();
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
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: mock });
  try {
    for (const [mode] of ICON_MODES) {
      const next = reducer(initialState, { type: 'SET_THEME', theme: { appIconMode: mode } });
      assert.equal(next.theme.appIconMode, mode);
      const persisted: unknown = JSON.parse(values.get('droid-theme') ?? '{}');
      assert.ok(persisted && typeof persisted === 'object');
      assert.equal((persisted as { appIconMode?: string }).appIconMode, mode);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
