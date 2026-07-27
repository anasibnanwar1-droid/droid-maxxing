import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeSessionAfterNativeBrowserRequest,
  browserKeyForSession,
  appSessionIdForBrowserKey,
  nativeBrowserRequestTargetsVisibleSurface,
} from './browserSessionIdentity';
import type { BrowserNativeRequest, SessionSummary } from '../types/bridge';

const session = (appSessionId: string, providerSessionId?: string): SessionSummary => ({
  appSessionId,
  providerSessionId,
  sessionPurpose: 'chat',
  interactionMode: 'auto',
  role: 'primary',
  title: appSessionId,
  goal: appSessionId,
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

test('browserKeyForSession uses the stable app session id through compaction', () => {
  // The provider session id changes on compaction; the browser
  // key must stay the app id so browser tools keep targeting the visible chat.
  assert.equal(browserKeyForSession(session('app-1', 'provider-after-compaction')), 'app-1');
  assert.equal(browserKeyForSession(session('app-2')), 'app-2');
});

test('activeSessionAfterNativeBrowserRequest does not steal the current chat', () => {
  const request: BrowserNativeRequest = {
    requestId: 'req-1',
    appSessionId: 'background-chat',
    browserSessionId: 'browser-background-chat',
    action: 'snapshot',
  };

  assert.equal(activeSessionAfterNativeBrowserRequest('visible-chat', request), 'visible-chat');
  assert.equal(activeSessionAfterNativeBrowserRequest(null, request), 'background-chat');
});

test('appSessionIdForBrowserKey resolves the app identity from the stable browser key', () => {
  const sessions = {
    'chat-app-id': session('chat-app-id', 'provider-after-compaction'),
  };

  // The backend keys browser requests by appSessionId.
  assert.equal(appSessionIdForBrowserKey(sessions, 'chat-app-id'), 'chat-app-id');
  assert.equal(
    activeSessionAfterNativeBrowserRequest(
      null,
      {
        requestId: 'req-1',
        appSessionId: 'chat-app-id',
        browserSessionId: 'browser-chat-app-id',
        action: 'snapshot',
      },
      sessions,
    ),
    'chat-app-id',
  );
});

test('nativeBrowserRequestTargetsVisibleSurface only attaches the active browser request', () => {
  assert.equal(
    nativeBrowserRequestTargetsVisibleSurface({
      browserKey: 'visible-chat',
      requestAppSessionId: 'visible-chat',
      requestBrowserSessionId: 'browser-visible-chat',
    }),
    true,
  );

  assert.equal(
    nativeBrowserRequestTargetsVisibleSurface({
      browserKey: 'visible-chat',
      visibleBrowserSessionId: 'browser-visible-chat',
      requestAppSessionId: 'background-chat',
      requestBrowserSessionId: 'browser-visible-chat',
    }),
    true,
  );

  assert.equal(
    nativeBrowserRequestTargetsVisibleSurface({
      browserKey: 'visible-chat',
      requestAppSessionId: 'background-chat',
      requestBrowserSessionId: 'browser-background-chat',
    }),
    false,
  );
});
