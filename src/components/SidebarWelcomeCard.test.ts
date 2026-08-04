import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarWelcomeCard } from './SidebarWelcomeCard';

function findButtons(node: ReactNode): ReactElement<{ onClick: () => void }>[] {
  if (!isValidElement(node)) return [];
  const buttons = node.type === 'button' ? [node as ReactElement<{ onClick: () => void }>] : [];
  const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  return buttons.concat(children.flatMap((child) => findButtons(child)));
}

const render = (onStart = () => undefined, onDismiss = () => undefined) =>
  renderToStaticMarkup(createElement(SidebarWelcomeCard, { onStart, onDismiss }));

test('greets with the nebula artwork and the welcome title', () => {
  const html = render();
  assert.match(html, /Welcome to Droidex/);
  assert.match(html, /welcome-nebula\.jpg/);
  assert.match(html, /Chats, workspaces and missions live here/);
});

test('offers a primary start-a-chat action and a dismiss button, no learn-more link', () => {
  const html = render();
  assert.match(html, /<button[^>]*>.*Start a chat.*<\/button>/s);
  assert.match(html, /aria-label="Dismiss"/);
  assert.doesNotMatch(html, /Learn more/);
});

test('invokes the start and dismiss actions from their buttons', () => {
  let started = false;
  let dismissed = false;
  const card = SidebarWelcomeCard({
    onStart: () => {
      started = true;
    },
    onDismiss: () => {
      dismissed = true;
    },
  });
  const buttons = findButtons(card);

  buttons[0]?.props.onClick();
  buttons[1]?.props.onClick();

  assert.equal(started, true);
  assert.equal(dismissed, true);
});
