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

test('lists every step as a ring: filled when done, spinning when active, empty when pending', () => {
  const html = render([
    { status: 'completed', text: 'Investigate the APIs' },
    { status: 'in_progress', text: 'Start a new app' },
    { status: 'pending', text: 'Implement the tracker' },
  ]);
  // No numeric fractions anywhere.
  assert.doesNotMatch(html, /[123]\/3/);
  // The one completed step is the only filled ring with a check.
  assert.equal(html.match(/rounded-full bg-droid-accent/g)?.length, 1);
  assert.equal(html.match(/lucide-check/g)?.length, 1);
  // Header + active row rings spin at a medium pace; the pending ring stays empty.
  assert.equal(html.match(/animate-spin/g)?.length, 2);
  assert.equal(html.match(/animation-duration:1\.4s/g)?.length, 2);
  assert.equal(html.match(/border-\[1\.5px\]/g)?.length, 3);
});

test('the collapsed header keeps the current step visible with the spinning ring', () => {
  const steps: TodoItem[] = [
    { status: 'completed', text: 'Investigate the APIs' },
    { status: 'completed', text: 'Start a new app' },
    { status: 'in_progress', text: 'Implement the tracker' },
    { status: 'pending', text: 'Ship it' },
  ];
  const html = render(steps, true);
  assert.match(html, /aria-expanded="false"/);
  // The collapsed row is the third step, spinning — not a generic counter.
  assert.match(html, /Implement the tracker/);
  assert.match(html, /animate-spin/);
  assert.doesNotMatch(html, /3\/4/);
});

test('the header ring only spins while the session is generating', () => {
  const steps: TodoItem[] = [{ status: 'in_progress', text: 'Start a new app' }];
  assert.match(render(steps, true), /animate-spin/);
  assert.doesNotMatch(render(steps, false), /animate-spin/);
});

test('an incomplete stopped plan uses an empty ring without a paused spinner arc', () => {
  const html = render([{ status: 'in_progress', text: 'Start a new app' }], false);
  assert.doesNotMatch(html, /animate-spin/);
  assert.doesNotMatch(html, /border-t-droid-text/);
  assert.match(html, /border-droid-text-muted\/30/);
});

test('finished plan fills every ring and drops the active band', () => {
  const html = render(
    [
      { status: 'completed', text: 'Investigate the APIs' },
      { status: 'completed', text: 'Start a new app' },
    ],
    false,
  );
  assert.doesNotMatch(html, /animate-spin/);
  // Header plus both rows read as filled, checked rings.
  assert.equal(html.match(/lucide-check/g)?.length, 3);
  assert.doesNotMatch(html, /bg-droid-active\/50/);
  // The header falls back to the last step once nothing is running.
  assert.match(html, /Start a new app/);
});
