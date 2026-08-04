import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiagnosticsSettings } from './DiagnosticsSettings.js';

test('diagnostics settings discloses automatic crash intake and its disable behavior', () => {
  const html = renderToStaticMarkup(createElement(DiagnosticsSettings));

  assert.match(html, /Crash reports and Release Health/);
  assert.match(html, /native crash dumps/);
  assert.match(html, /incidental sensitive data/);
  assert.match(html, /Changing this setting immediately restarts DROIDEX/);
  assert.match(html, /Turning it off stops automatic reporting and deletes the local profile ID/);
  assert.match(html, /aria-label="Automatic crash reports and Release Health"/);
});
