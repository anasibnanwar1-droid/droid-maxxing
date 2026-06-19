import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ErrorBoundary, { AppFallback, PaneFallback } from './ErrorBoundary';

const noop = () => {};

test('#38 getDerivedStateFromError captures the error into fallback state', () => {
  const err = new Error('boom');
  assert.deepEqual(ErrorBoundary.getDerivedStateFromError(err), { error: err });
});

test('#38 renders children unchanged when nothing throws', () => {
  const html = renderToStaticMarkup(
    createElement(ErrorBoundary, { scope: 'app' }, createElement('div', null, 'safe content')),
  );
  assert.ok(html.includes('safe content'));
  assert.ok(!html.includes('Something went wrong'));
});

test('#38 app recovery screen surfaces the error and a reload action', () => {
  const html = renderToStaticMarkup(
    createElement(AppFallback, { error: new Error('kaboom'), onRecover: noop, onReload: noop }),
  );
  assert.ok(html.includes('Something went wrong'));
  assert.ok(html.includes('Reload app'));
  assert.ok(html.includes('Try to recover'));
  assert.ok(html.includes('kaboom'));
});

test('#38 pane fallback is compact, labelled, and not the full app screen', () => {
  const html = renderToStaticMarkup(
    createElement(PaneFallback, { label: 'Browser', error: new Error('oops'), onRetry: noop }),
  );
  assert.ok(html.includes('Browser'));
  assert.ok(html.includes('Retry'));
  assert.ok(html.includes('oops'));
  assert.ok(!html.includes('Reload app'));
});

test('#38 a child component can be supplied as a node and renders inside the boundary', () => {
  const child: ReactNode = createElement('span', null, 'shell stays');
  const html = renderToStaticMarkup(createElement(ErrorBoundary, { scope: 'app' }, child));
  assert.ok(html.includes('shell stays'));
});
