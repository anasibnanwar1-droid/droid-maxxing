import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FeedbackModal } from './FeedbackModal';

function render(category: 'bug' | 'other', description = '') {
  return renderToStaticMarkup(
    createElement(FeedbackModal, {
      initialReport: { category, description },
      onClose: () => undefined,
    }),
  );
}

test('feedback modal exposes categories, required details, and the diagnostics boundary', () => {
  const html = render('bug', 'Update froze');

  assert.match(html, /role="dialog"/);
  assert.match(html, /Share feedback/);
  assert.match(html, /Bug/);
  assert.match(html, /Bad result/);
  assert.match(html, /Good result/);
  assert.match(html, /Safety/);
  assert.match(html, /Other/);
  assert.match(html, /Update froze/);
  assert.match(html, /Chats, files, browser content, keys, and credentials/);
  assert.match(html, /Submit report/);
  assert.match(html, /aria-modal="true"/);
});

test('slash feedback defaults the modal to Other', () => {
  const html = render('other');
  assert.match(html, /aria-pressed="true"[^>]*>.*Other/s);
});
