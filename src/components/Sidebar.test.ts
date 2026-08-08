import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SessionRow,
  UnreadFilterActions,
  areSessionRowPropsEqual,
  type SessionRowProps,
} from './Sidebar';
import type { SessionSummary } from '../types/bridge';

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    appSessionId: 'sess-a',
    sessionPurpose: 'chat',
    interactionMode: 'auto',
    role: 'primary',
    title: 'Build the thing',
    goal: '',
    cwd: '',
    autonomy: 'off',
    phase: 'completed',
    features: [],
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function makeProps(overrides: Partial<SessionRowProps> = {}): SessionRowProps {
  return {
    session: makeSession(),
    active: false,
    unread: false,
    running: false,
    now: 5_000,
    onSelect: () => undefined,
    ...overrides,
  };
}

const render = (props: SessionRowProps) => renderToStaticMarkup(createElement(SessionRow, props));

test('unread actions expose Mark all as read only inside a non-empty unread view', () => {
  const hidden = renderToStaticMarkup(
    createElement(UnreadFilterActions, {
      unreadOnly: false,
      unreadCount: 12,
      onToggleUnread: () => undefined,
      onMarkAllRead: () => undefined,
    }),
  );
  assert.match(hidden, /aria-label="Show unread only"/);
  assert.match(hidden, />9\+</);
  assert.doesNotMatch(hidden, /Mark all as read/);

  const visible = renderToStaticMarkup(
    createElement(UnreadFilterActions, {
      unreadOnly: true,
      unreadCount: 2,
      onToggleUnread: () => undefined,
      onMarkAllRead: () => undefined,
    }),
  );
  assert.match(visible, /aria-label="Show all sessions"/);
  assert.match(visible, /Mark all as read/);

  const empty = renderToStaticMarkup(
    createElement(UnreadFilterActions, {
      unreadOnly: true,
      unreadCount: 0,
      onToggleUnread: () => undefined,
      onMarkAllRead: () => undefined,
    }),
  );
  assert.doesNotMatch(empty, /Mark all as read/);
});

test('areSessionRowPropsEqual ignores unrelated session updates', () => {
  const onSelect = () => undefined;
  const prev = makeProps({ session: makeSession(), onSelect });
  const next = makeProps({
    session: makeSession({ contextTokens: 500, tokensIn: 200, tokensOut: 300 }),
    onSelect,
  });
  assert.equal(areSessionRowPropsEqual(prev, next), true);
});

test('areSessionRowPropsEqual detects row-visible session updates', () => {
  const onSelect = () => undefined;
  const base = makeProps({ onSelect });
  const changes: Partial<SessionSummary>[] = [
    { appSessionId: 'sess-b' },
    { title: 'Changed title' },
    { updatedAt: 2_000 },
  ];

  for (const change of changes) {
    const next = makeProps({ session: makeSession(change), onSelect });
    assert.equal(areSessionRowPropsEqual(base, next), false);
  }
});

test('areSessionRowPropsEqual: active change is not equal', () => {
  const props = makeProps();
  assert.equal(
    areSessionRowPropsEqual({ ...props, active: false }, { ...props, active: true }),
    false,
  );
});

test('areSessionRowPropsEqual: unread change is not equal', () => {
  const props = makeProps();
  assert.equal(
    areSessionRowPropsEqual({ ...props, unread: false }, { ...props, unread: true }),
    false,
  );
});

test('areSessionRowPropsEqual: running change is not equal', () => {
  const props = makeProps();
  assert.equal(
    areSessionRowPropsEqual({ ...props, running: false }, { ...props, running: true }),
    false,
  );
});

test('areSessionRowPropsEqual: now change is not equal', () => {
  const props = makeProps();
  assert.equal(areSessionRowPropsEqual({ ...props, now: 5_000 }, { ...props, now: 35_000 }), false);
});

test('areSessionRowPropsEqual: a new onSelect identity is not equal', () => {
  const session = makeSession();
  const prev = makeProps({ session, onSelect: () => undefined });
  const next = makeProps({ session, onSelect: () => undefined });
  assert.equal(areSessionRowPropsEqual(prev, next), false);
});

test('SessionRow renders the session title and targets it by appSessionId', () => {
  const html = render(makeProps({ session: makeSession({ appSessionId: 'sess-a' }) }));
  assert.match(html, /Build the thing/);
  assert.match(html, /data-app-session-id="sess-a"/);
});

test('SessionRow: a running row shows pulsing dots and no relative timestamp', () => {
  const html = render(
    makeProps({ running: true, now: 9_999, session: makeSession({ updatedAt: 0 }) }),
  );
  assert.match(html, /dot-pulse/);
  // updatedAt=0 -> formatRelativeTime returns ''; with running=true the time
  // span is never rendered anyway.
  assert.doesNotMatch(html, /tabular-nums/);
});

test('SessionRow: an idle row shows the relative timestamp and no pulsing dots', () => {
  // updatedAt (1s) vs now (60s) -> "now", a non-empty label proving the time
  // branch rendered; the key assertion is the absence of the working dots.
  const html = render(makeProps({ running: false, now: 60_000 }));
  assert.doesNotMatch(html, /dot-pulse/);
  assert.match(html, /tabular-nums/);
});
