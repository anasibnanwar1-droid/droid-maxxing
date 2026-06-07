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
