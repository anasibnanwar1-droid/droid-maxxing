import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import SessionComposer from './SessionComposer';

function renderComposer(isLive: boolean, hasContent: boolean): string {
  return renderToStaticMarkup(
    createElement(SessionComposer, {
      value: hasContent ? 'Follow up' : '',
      onValueChange: () => undefined,
      onSubmit: () => undefined,
      isLive,
      hasContent,
      canSubmit: hasContent,
      liveEnterBehavior: 'interrupt',
      placeholder: 'Message',
      onStop: () => undefined,
    }),
  );
}

test('the shared composer keeps Stop available while a live follow-up is drafted', () => {
  const html = renderComposer(true, true);
  assert.match(html, /aria-label="Stop current turn"/);
  assert.match(html, /aria-label="Steer current turn"/);
});

test('the shared composer hides Send for an empty live draft', () => {
  const html = renderComposer(true, false);
  assert.match(html, /aria-label="Stop current turn"/);
  assert.doesNotMatch(html, /aria-label="Steer current turn"/);
});

test('the shared composer shows only Send while the session is idle', () => {
  const html = renderComposer(false, false);
  assert.doesNotMatch(html, /aria-label="Stop current turn"/);
  assert.match(html, /aria-label="Send prompt"/);
});
