import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SubagentsSection } from './SubagentsPanel';
import type { ChildSessionSummary, ChildStatus } from '../types/bridge';

let seq = 0;
function child(
  status: ChildStatus,
  overrides: Partial<ChildSessionSummary> = {},
): ChildSessionSummary {
  seq += 1;
  return {
    parentAppSessionId: 'p',
    childSessionId: `child-${seq}`,
    role: 'worker',
    status,
    label: `agent-${seq}`,
    modelId: 'droid-core',
    transcriptAvailable: true,
    startedAt: seq,
    ...overrides,
  };
}

function renderSection(
  childSessions: ChildSessionSummary[],
  extra: Partial<Parameters<typeof SubagentsSection>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(SubagentsSection, {
      childSessions,
      models: [],
      selectedChildSessionId: null,
      onSelect: () => undefined,
      ...extra,
    }),
  );
}

// Adjacent text expressions render with comment separators; strip them so text
// assertions match what a user reads.
const textOf = (html: string) => html.replace(/<!--.*?-->/g, '');

test('the header stays a plain label without live counts', () => {
  const text = textOf(
    renderSection([child('running'), child('running'), child('pending'), child('completed')]),
  );
  assert.ok(text.includes('Subagents'));
  assert.ok(!text.includes('3 working'));
  assert.ok(!text.includes('1 done'));
});

test('rows render the label and a quiet status readout', () => {
  const html = renderSection([
    child('running', { label: 'explorer' }),
    child('pending', { label: 'fixer' }),
    child('paused', { label: 'idler' }),
    child('completed', { label: 'reviewer' }),
  ]);
  const text = textOf(html);
  assert.ok(text.includes('explorer'));
  assert.ok(text.includes('Working'));
  assert.ok(text.includes('Queued'));
  assert.ok(text.includes('Idle'));
  assert.ok(text.includes('Done'));
  // The working readout shimmers instead of spinning or pulsing.
  assert.match(html, /shimmer-text[^"]*">Working/);
});

test('the list folds past five rows behind a show-more button', () => {
  const children = Array.from({ length: 7 }, () => child('running'));
  const html = renderSection(children);
  assert.equal(html.match(/data-testid="subagent-row"/g)?.length, 5);
  assert.ok(textOf(html).includes('Show 2 more'));
});

test('no fold at or below the visible limit', () => {
  const html = renderSection(Array.from({ length: 5 }, () => child('running')));
  assert.equal(html.match(/data-testid="subagent-row"/g)?.length, 5);
  assert.ok(!textOf(html).includes('Show'));
});

test('a working agent stays above the fold when finished agents spawned first', () => {
  const done = Array.from({ length: 6 }, () => child('completed'));
  const working = child('running', { label: 'late-worker' });
  const html = renderSection([...done, working]);
  const rows = [...html.matchAll(/data-child-session-id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(rows.length, 5);
  // The still-working agent leads the list instead of being pushed behind
  // "Show 2 more" by the six agents that already finished.
  assert.equal(rows[0], working.childSessionId);
  assert.ok(textOf(html).includes('Show 2 more'));
});

test('a spawn the store has not registered yet renders but cannot be opened', () => {
  const html = renderSection([
    child('running', { childSessionId: 'pending-tool-a', label: 'explorer' }),
  ]);
  assert.ok(textOf(html).includes('explorer'));
  assert.match(html, /<button[^>]*disabled/);
});

test('the open agent stays visible even when it belongs behind the fold', () => {
  const rest = Array.from({ length: 6 }, () => child('completed'));
  const target = child('completed', { label: 'last-finisher' });
  const html = renderSection([...rest, target], {
    selectedChildSessionId: target.childSessionId,
  });
  const rows = [...html.matchAll(/data-child-session-id="([^"]+)"/g)].map((m) => m[1]);
  // Five rows fit before the fold; the selected sixth is kept alongside them so
  // the panel never shows an agent's transcript with no row to point at.
  assert.equal(rows.length, 6);
  assert.ok(rows.includes(target.childSessionId));
  assert.ok(textOf(html).includes('Show 1 more'));
});

test('the selected row is highlighted', () => {
  const target = child('running');
  const html = renderSection([child('running'), target], {
    selectedChildSessionId: target.childSessionId,
  });
  assert.match(
    html,
    new RegExp(`data-child-session-id="${target.childSessionId}" class="[^"]*bg-droid-elevated/70`),
  );
});
