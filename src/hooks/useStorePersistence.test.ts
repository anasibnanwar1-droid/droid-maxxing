import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPersistedUiState } from './useStore';

test('loadPersistedUiState returns an empty snapshot when storage is empty', () => {
  withLocalStorage(null, () => {
    assert.deepEqual(loadPersistedUiState(), {});
  });
});

test('loadPersistedUiState sanitizes persisted shell fields', () => {
  withLocalStorage(JSON.stringify({
    activeMissionId: 'm1',
    rightPanelOpen: false,
    sidebarCollapsed: true,
    specMode: true,
    missionMode: false,
    browserOpen: true,
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
  }), () => {
    assert.deepEqual(loadPersistedUiState(), {
      activeMissionId: 'm1',
      rightPanelOpen: false,
      sidebarCollapsed: true,
      specMode: true,
      missionMode: false,
      browserOpen: true,
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
  });
});

function withLocalStorage(value: string | null, fn: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const mock: Storage = {
    getItem: () => value,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: value ? 1 : 0,
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
