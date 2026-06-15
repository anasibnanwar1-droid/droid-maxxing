import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeMissionAfterNativeBrowserRequest,
  browserKeyForMission,
  missionIdForBrowserKey,
  nativeBrowserRequestTargetsVisibleSurface,
} from './browserSessionIdentity';
import type { BrowserNativeRequest, MissionSummary } from '../types/bridge';

const mission = (id: string, sessionId?: string): MissionSummary => ({
  id,
  sessionId,
  kind: 'mission_orchestrator',
  role: 'orchestrator',
  title: id,
  goal: id,
  cwd: '',
  workspaceKind: 'none',
  autonomy: 'low',
  phase: 'running',
  features: [],
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  createdAt: 1,
  updatedAt: 1,
});

test('browserKeyForMission uses the stable app session id (survives compaction)', () => {
  // The droid session id (mission.sessionId) changes on compaction; the browser
  // key must stay the app id so browser tools keep targeting the visible chat.
  assert.equal(browserKeyForMission(mission('app-1', 'droid-session-after-compaction')), 'app-1');
  assert.equal(browserKeyForMission(mission('app-2')), 'app-2');
});

test('activeMissionAfterNativeBrowserRequest does not steal the current chat', () => {
  const request: BrowserNativeRequest = {
    requestId: 'req-1',
    missionId: 'background-chat',
    sessionId: 'browser-background-chat',
    action: 'snapshot',
  };

  assert.equal(activeMissionAfterNativeBrowserRequest('visible-chat', request), 'visible-chat');
  assert.equal(activeMissionAfterNativeBrowserRequest(null, request), 'background-chat');
});

test('missionIdForBrowserKey resolves the app chat id from the stable browser key', () => {
  const missions = {
    'chat-app-id': mission('chat-app-id', 'droid-session-after-compaction'),
  };

  // The backend keys browser requests by the app session id (mission.id).
  assert.equal(missionIdForBrowserKey(missions, 'chat-app-id'), 'chat-app-id');
  assert.equal(
    activeMissionAfterNativeBrowserRequest(
      null,
      {
        requestId: 'req-1',
        missionId: 'chat-app-id',
        sessionId: 'browser-chat-app-id',
        action: 'snapshot',
      },
      missions,
    ),
    'chat-app-id',
  );
});

test('nativeBrowserRequestTargetsVisibleSurface only attaches the active browser request', () => {
  assert.equal(
    nativeBrowserRequestTargetsVisibleSurface({
      browserKey: 'visible-chat',
      requestMissionId: 'visible-chat',
      requestSessionId: 'browser-visible-chat',
    }),
    true,
  );

  assert.equal(
    nativeBrowserRequestTargetsVisibleSurface({
      browserKey: 'visible-chat',
      visibleSessionId: 'browser-visible-chat',
      requestMissionId: 'background-chat',
      requestSessionId: 'browser-visible-chat',
    }),
    true,
  );

  assert.equal(
    nativeBrowserRequestTargetsVisibleSurface({
      browserKey: 'visible-chat',
      requestMissionId: 'background-chat',
      requestSessionId: 'browser-background-chat',
    }),
    false,
  );
});
