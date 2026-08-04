import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarWelcomeCard } from './SidebarWelcomeCard';

const noop = () => undefined;

const render = () =>
  renderToStaticMarkup(createElement(SidebarWelcomeCard, { onStart: noop, onDismiss: noop }));

test('greets with the nebula artwork and the welcome title', () => {
  const html = render();
  assert.match(html, /Welcome to Droidex/);
  assert.match(html, /welcome-nebula\.jpg/);
  assert.match(html, /Chats, workspaces and missions live here/);
});

test('offers a primary start-a-chat action and a dismiss button, no learn-more link', () => {
  const html = render();
  assert.match(html, /Start a chat/);
  assert.match(html, /aria-label="Dismiss"/);
  assert.doesNotMatch(html, /Learn more/);
});
