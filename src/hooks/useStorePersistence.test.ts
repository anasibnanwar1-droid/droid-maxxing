import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFactoryCompactionDefaults,
  compactionSettingsSnapshot,
  loadPersistedUiState,
} from './useStore';

test('loadPersistedUiState returns an empty snapshot when storage is empty', () => {
  withLocalStorage(null, () => {
    assert.deepEqual(loadPersistedUiState(), {});
  });
});

test('loadPersistedUiState sanitizes persisted shell fields', () => {
  withLocalStorage(
    JSON.stringify({
      activeMissionId: 'm1',
      rightPanelOpen: false,
      sidebarCollapsed: true,
      specMode: true,
      missionMode: false,
      utilityPanels: {
        m1: {
          open: true,
          activeTabId: 'terminal-1',
          tabs: [
            { id: 'review', tool: 'review', label: 'Review' },
            {
              id: 'terminal-1',
              tool: 'terminal',
              label: 'Terminal',
              terminalId: 'pty-1',
            },
          ],
        },
      },
      browserOpenKeys: { 'chat-1': true, 'chat-2': false, '': true },
      browsers: {
        'chat-1': {
          sessionId: 'browser-chat-1',
          missionId: 'chat-1',
          url: 'http://127.0.0.1:17777/',
          title: 'Local app',
          viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
          viewportMode: 'fit',
          scroll: { x: 3, y: 7 },
          refs: [{ stale: true }],
          agentCursor: { x: 1, y: 2 },
          screenshotPath: '/tmp/old.png',
        },
        bad: { url: 'https://example.com' },
      },
      selectedFeatureId: 'f1',
      selectedAgentSessionId: 'orchestrator',
      settingsOpen: true,
    }),
    () => {
      assert.deepEqual(loadPersistedUiState(), {
        activeMissionId: 'm1',
        rightPanelOpen: false,
        sidebarCollapsed: true,
        specMode: true,
        missionMode: false,
        utilityPanels: {
          m1: {
            open: true,
            activeTabId: 'review',
            tabs: [{ id: 'review', tool: 'review', label: 'Review' }],
          },
        },
        browserOpenKeys: { 'chat-1': true, 'chat-2': false },
        browsers: {
          'chat-1': {
            sessionId: 'browser-chat-1',
            missionId: 'chat-1',
            url: 'http://127.0.0.1:17777/',
            title: 'Local app',
            viewport: { width: 1200, height: 800, deviceScaleFactor: 2 },
            viewportMode: 'fit',
            scroll: { x: 3, y: 7 },
            refs: [],
          },
        },
        selectedFeatureId: 'f1',
        selectedAgentSessionId: 'orchestrator',
      });
    },
  );
});

test('factory defaults do not restore a cleared per-model compaction override', () => {
  withLocalStorageMap({ 'droid-compaction-token-limit-per-model': '{}' }, () => {
    assert.deepEqual(
      applyFactoryCompactionDefaults(
        { compactionTokenLimit: undefined, compactionTokenLimitPerModel: {} },
        { compactionTokenLimitPerModel: { 'model-a': 100_000 } },
      ),
      { compactionTokenLimit: undefined, compactionTokenLimitPerModel: {} },
    );
  });
});

test('factory defaults do not restore a cleared global compaction token limit', () => {
  withLocalStorageMap({ 'droid-compaction-token-limit-configured': '1' }, () => {
    assert.deepEqual(
      applyFactoryCompactionDefaults(
        { compactionTokenLimit: undefined, compactionTokenLimitPerModel: {} },
        { compactionTokenLimit: 100_000 },
      ),
      { compactionTokenLimit: undefined, compactionTokenLimitPerModel: {} },
    );
  });
});

test('factory defaults seed compaction token limits before local settings exist', () => {
  const storage = new Map<string, string>();
  withLocalStorageMap(storage, () => {
    assert.deepEqual(
      applyFactoryCompactionDefaults(
        { compactionTokenLimit: undefined, compactionTokenLimitPerModel: {} },
        { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-a': 100_000 } },
      ),
      { compactionTokenLimit: 200_000, compactionTokenLimitPerModel: { 'model-a': 100_000 } },
    );
    assert.equal(storage.get('droid-compaction-token-limit'), '200000');
    assert.equal(storage.get('droid-compaction-token-limit-per-model'), '{"model-a":100000}');
  });
});

test('compaction settings snapshots distinguish cold startup from explicit clears', () => {
  withLocalStorageMap({}, () => {
    assert.deepEqual(
      compactionSettingsSnapshot({
        compactionTokenLimit: undefined,
        compactionTokenLimitPerModel: {},
      }),
      {},
    );
  });

  withLocalStorageMap(
    {
      'droid-compaction-token-limit-configured': '1',
      'droid-compaction-token-limit-per-model': '{}',
    },
    () => {
      assert.deepEqual(
        compactionSettingsSnapshot({
          compactionTokenLimit: undefined,
          compactionTokenLimitPerModel: {},
        }),
        { compactionTokenLimit: null, compactionTokenLimitPerModel: {} },
      );
    },
  );
});

function withLocalStorage(value: string | null, fn: () => void): void {
  withLocalStorageMap(value === null ? {} : { 'droid-ui-state-v1': value }, fn);
}

function withLocalStorageMap(
  seed: Record<string, string> | Map<string, string>,
  fn: () => void,
): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = seed instanceof Map ? seed : new Map(Object.entries(seed));
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
