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

test('collapsed plan keeps its only spinner in the summary row', () => {
  const html = render([
    { status: 'completed', text: 'Investigate the APIs' },
    { status: 'in_progress', text: 'Start a new app' },
    { status: 'pending', text: 'Implement the tracker' },
  ]);
  // No numeric fractions anywhere.
  assert.doesNotMatch(html, /\d+\/\d+/);
  // The one completed step is the only filled ring with a check.
  assert.equal(html.match(/rounded-full bg-droid-accent/g)?.length, 1);
  assert.equal(html.match(/lucide-check/g)?.length, 1);
  const header = /<button[^>]*aria-expanded="false"[^>]*>.*?<\/button>/s.exec(html)?.[0];
  assert.match(header ?? '', /animate-spin/);
  // Hidden list rows retain their status rings without a duplicate animation.
  const rows = [
    ...html.matchAll(
      /<div class="flex min-w-0 items-center gap-2\.5 px-4 py-1\.5[^>]*>.*?<\/div>/gs,
    ),
  ].map(([row]) => row);
  const activeRow = rows.find((row) => row.includes('Start a new app'));
  const pendingRow = rows.find((row) => row.includes('Implement the tracker'));
  assert.doesNotMatch(activeRow ?? '', /animate-spin/);
  assert.doesNotMatch(pendingRow ?? '', /animate-spin/);
  assert.equal(html.match(/animate-spin/g)?.length, 1);
  assert.equal(html.match(/animation-duration:1\.4s/g)?.length, 1);
  assert.equal(html.match(/border-\[1\.5px\]/g)?.length, 3);
});

test('expanded steps are capped and scroll above the fixed summary row', () => {
  const html = render([
    { status: 'in_progress', text: 'Start a new app' },
    { status: 'pending', text: 'Implement the tracker' },
  ]);
  const listIndex = html.indexOf('id="plan-steps-list"');
  const summaryIndex = html.indexOf('<button');

  assert.ok(listIndex >= 0 && listIndex < summaryIndex);
  assert.match(html, /expanded-steps/);
  assert.match(html, /min-h-0/);
  assert.match(html, /max-h-\[min\(40vh,350px\)\]/);
  assert.match(html, /overflow-y-auto/);
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
  const header = /<button[^>]*aria-expanded="false"[^>]*>.*?<\/button>/s.exec(html)?.[0];
  assert.match(header ?? '', /Implement the tracker/);
  assert.match(header ?? '', /animate-spin/);
  assert.doesNotMatch(html, /\d+\/\d+/);
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
