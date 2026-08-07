import test from 'node:test';
import assert from 'node:assert/strict';
import { withLocalStorageMap } from '../test/localStorage';
import type { SessionSummary, TranscriptEvent } from '../types/bridge';
import {
  collectFinishedSessions,
  decideFinishNotification,
  DEFAULT_FINISH_NOTIFICATION_SETTINGS,
  isAppInForeground,
  latestAssistantSnippet,
  loadFinishNotificationSettings,
  normalizeFinishNotificationSettings,
  notificationSnippet,
  saveFinishNotificationSettings,
} from './finishNotifications';

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    appSessionId: 's1',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: 'Refactor notifications',
    goal: '',
    cwd: '',
    workspaceKind: 'none',
    autonomy: 'low',
    phase: 'paused',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as SessionSummary;

const textEvent = (text: string, over: Partial<TranscriptEvent> = {}): TranscriptEvent =>
  ({
    id: `e-${text.slice(0, 8)}`,
    appSessionId: 's1',
    sourceSessionId: 's1',
    role: 'primary',
    ts: 1,
    kind: 'text',
    text,
    ...over,
  }) as TranscriptEvent;

test('notificationSnippet trims and caps with an ellipsis', () => {
  assert.equal(notificationSnippet('  hello   world  '), 'hello world');
  const long = 'word '.repeat(80);
  const snip = notificationSnippet(long, 40);
  assert.ok(snip.endsWith('…'));
  assert.ok(snip.length <= 40);
  assert.equal(notificationSnippet(''), '');
});

test('latestAssistantSnippet prefers the newest primary assistant text', () => {
  const events = [
    textEvent('first answer'),
    { ...textEvent('thinking…'), kind: 'thinking' as const },
    textEvent('second answer is longer and wins'),
    textEvent('child only', { role: 'worker' }),
  ];
  assert.equal(latestAssistantSnippet(events), 'second answer is longer and wins');
  assert.equal(latestAssistantSnippet([]), '');
  assert.equal(latestAssistantSnippet(undefined), '');
});

test('decideFinishNotification respects settings and foreground gates', () => {
  const base = {
    session: session(),
    isActiveSession: false,
    assistantSnippet: 'Ship it.',
    appInForeground: false,
  };
  assert.equal(
    decideFinishNotification({
      ...base,
      settings: { ...DEFAULT_FINISH_NOTIFICATION_SETTINGS, enabled: false },
    }).kind,
    'skip',
  );
  assert.equal(
    decideFinishNotification({
      ...base,
      isActiveSession: true,
      settings: { ...DEFAULT_FINISH_NOTIFICATION_SETTINGS, notifyActiveSession: false },
    }).kind,
    'skip',
  );
  assert.equal(
    decideFinishNotification({
      ...base,
      appInForeground: true,
      settings: { ...DEFAULT_FINISH_NOTIFICATION_SETTINGS, suppressWhenFocused: true },
    }).kind,
    'skip',
  );
  // Foreground is fine when the user disabled that gate.
  assert.equal(
    decideFinishNotification({
      ...base,
      appInForeground: true,
      settings: { ...DEFAULT_FINISH_NOTIFICATION_SETTINGS, suppressWhenFocused: false },
    }).kind,
    'notify',
  );

  const ok = decideFinishNotification({
    ...base,
    settings: DEFAULT_FINISH_NOTIFICATION_SETTINGS,
  });
  assert.equal(ok.kind, 'notify');
  if (ok.kind === 'notify') {
    assert.equal(ok.title, 'Refactor notifications');
    assert.equal(ok.body, 'Ship it.');
    assert.equal(ok.silent, false);
  }

  const quiet = decideFinishNotification({
    ...base,
    settings: { ...DEFAULT_FINISH_NOTIFICATION_SETTINGS, playSound: false },
  });
  assert.equal(quiet.kind, 'notify');
  if (quiet.kind === 'notify') assert.equal(quiet.silent, true);
});

test('decideFinishNotification uses a failed title when the phase failed', () => {
  const decision = decideFinishNotification({
    settings: DEFAULT_FINISH_NOTIFICATION_SETTINGS,
    session: session({ phase: 'failed', title: 'Broken turn' }),
    isActiveSession: false,
    assistantSnippet: '',
    appInForeground: false,
  });
  assert.equal(decision.kind, 'notify');
  if (decision.kind === 'notify') {
    assert.match(decision.title, /Failed/);
    assert.match(decision.body, /error/i);
  }
});

test('collectFinishedSessions only emits working→idle edges', () => {
  const live = session({
    appSessionId: 'live',
    phase: 'running',
    streaming: true,
  });
  const done = session({ appSessionId: 'done', phase: 'running', streaming: false });
  const idle = session({ appSessionId: 'idle', phase: 'completed', streaming: false });

  const first = collectFinishedSessions({
    sessions: { live, done, idle },
    previouslyWorking: new Set(['live', 'done']),
  });
  assert.deepEqual(
    first.finished.map((s) => s.appSessionId),
    ['done'],
  );
  assert.deepEqual([...first.stillWorking], ['live']);

  const cold = collectFinishedSessions({
    sessions: { idle },
    previouslyWorking: new Set(),
  });
  assert.equal(cold.finished.length, 0);
});

test('isAppInForeground uses visibility and hasFocus', () => {
  assert.equal(isAppInForeground({ visibilityState: 'hidden', hasFocus: () => true }), false);
  assert.equal(isAppInForeground({ visibilityState: 'visible', hasFocus: () => false }), false);
  assert.equal(isAppInForeground({ visibilityState: 'visible', hasFocus: () => true }), true);
});

test('finish notification settings round-trip through localStorage', () => {
  withLocalStorageMap({}, () => {
    assert.deepEqual(loadFinishNotificationSettings(), DEFAULT_FINISH_NOTIFICATION_SETTINGS);
    const saved = saveFinishNotificationSettings({
      enabled: true,
      suppressWhenFocused: false,
      playSound: false,
      notifyActiveSession: false,
    });
    assert.equal(saved.playSound, false);
    assert.deepEqual(loadFinishNotificationSettings(), saved);
  });

  assert.deepEqual(normalizeFinishNotificationSettings({ enabled: 'nope', playSound: false }), {
    ...DEFAULT_FINISH_NOTIFICATION_SETTINGS,
    playSound: false,
  });
});
