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

test('browserKeyForMission uses the chat session id before the mission id', () => {
  assert.equal(browserKeyForMission(mission('mission-1', 'chat-session-1')), 'chat-session-1');
  assert.equal(browserKeyForMission(mission('chat-session-2')), 'chat-session-2');
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

test('missionIdForBrowserKey maps Droid session ids back to app chat ids', () => {
  const missions = {
    'chat-app-id': mission('chat-app-id', 'droid-session-id'),
  };

  assert.equal(missionIdForBrowserKey(missions, 'droid-session-id'), 'chat-app-id');
  assert.equal(
    activeMissionAfterNativeBrowserRequest(
      null,
      {
        requestId: 'req-1',
        missionId: 'droid-session-id',
        sessionId: 'browser-droid-session-id',
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
