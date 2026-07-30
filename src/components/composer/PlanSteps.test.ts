import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanStepsPanel } from './PlanSteps';
import type { TodoItem } from '../../lib/tools';

const render = (steps: TodoItem[], isRunning = true) =>
  renderToStaticMarkup(createElement(PlanStepsPanel, { steps, isRunning, resetKey: 's' }));

test('renders nothing without a plan', () => {
  assert.equal(render([]), '');
});

test('collapsed header shows the running step', () => {
  const html = render([
    { status: 'completed', text: 'Investigate the APIs' },
    { status: 'in_progress', text: 'Start a new app' },
    { status: 'pending', text: 'Implement the tracker' },
  ]);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Start a new app/);
});

test('lists every step with its position and completion mark', () => {
  const html = render([
    { status: 'completed', text: 'Investigate the APIs' },
    { status: 'in_progress', text: 'Start a new app' },
    { status: 'pending', text: 'Implement the tracker' },
  ]);
  assert.match(html, /1\/3/);
  assert.match(html, /2\/3/);
  assert.match(html, /3\/3/);
  // Exactly the one completed step carries a check; the header glyph is the spinner.
  assert.equal(html.match(/lucide-check/g)?.length, 1);
  assert.match(html, /lucide-loader-circle/);
});

test('the header spinner only spins while the session is generating', () => {
  const steps: TodoItem[] = [{ status: 'in_progress', text: 'Start a new app' }];
  assert.match(render(steps, true), /animate-spin/);
  assert.doesNotMatch(render(steps, false), /animate-spin/);
});

test('finished plan swaps the header glyph to a check and drops the active band', () => {
  const html = render([
    { status: 'completed', text: 'Investigate the APIs' },
    { status: 'completed', text: 'Start a new app' },
  ]);
  assert.doesNotMatch(html, /lucide-loader-circle/);
  assert.equal(html.match(/lucide-check/g)?.length, 3);
  assert.doesNotMatch(html, /bg-droid-active\/50/);
  // The header falls back to the last step once nothing is running.
  assert.match(html, /Start a new app/);
});
