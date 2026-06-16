import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildFeed, groupTurns, isResultFor, MessageFeed, type FeedItem } from './chat';
import type { TranscriptEvent } from '../types/bridge';

let seq = 0;
function ev(extra: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    id: `e${seq++}`,
    missionId: 'm',
    agentSessionId: 'orchestrator',
    role: 'orchestrator',
    ts: seq,
    kind: 'text',
    ...extra,
  } as TranscriptEvent;
}

const userMsg = (text: string) => ev({ kind: 'text', author: 'user', text });
const asst = (text: string) => ev({ kind: 'text', text });
const todo = (todos: string) =>
  ev({ kind: 'tool_call', toolName: 'TodoWrite', toolArgs: { todos } });
const grep = () => ev({ kind: 'tool_call', toolName: 'Grep', toolArgs: { pattern: 'x' } });
const compaction = () => ev({ kind: 'compaction', removedCount: 3 });

// Find all top-level assistant chat messages (non-user) in a grouped feed.
function topLevelAnswers(items: FeedItem[]): string[] {
  return items
    .filter((it): it is Extract<FeedItem, { type: 'message' }> => it.type === 'message')
    .filter((it) => it.event.author !== 'user')
    .map((it) => it.event.text ?? '');
}

function workedChildren(items: FeedItem[]): FeedItem[] {
  return items
    .filter((it): it is Extract<FeedItem, { type: 'worked' }> => it.type === 'worked')
    .flatMap((it) => it.items);
}

// ── #20: TodoWrite / tool orchestration must not leak as chat ──

test('#20 a TodoWrite update does not add a chat message and answer stays single', () => {
  const events = [userMsg('do it'), todo('1. [in_progress] step'), asst('done')];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['done']);
  // No top-level item is the TodoWrite; it lives inside Worked activity.
  const planAtTop = grouped.some((it) => it.type === 'tools' || it.type === 'message');
  assert.ok(planAtTop); // sanity: message exists
  const inWorked = workedChildren(grouped).some((c) => c.type === 'tools');
  assert.ok(inWorked, 'TodoWrite activity should be inside the Worked group');
});

test('#20 repeated TodoWrite calls are deduped to the latest snapshot', () => {
  const events = [todo('1. [pending] a'), todo('1. [in_progress] a'), todo('1. [completed] a')];
  const items = buildFeed(events);
  const tools = items.find((it) => it.type === 'tools') as Extract<FeedItem, { type: 'tools' }>;
  assert.ok(tools, 'expected a tools group');
  const plans = tools.events.filter((e) => e.toolName === 'TodoWrite');
  assert.equal(plans.length, 1);
  assert.equal(
    plans[0].toolArgs && (plans[0].toolArgs as { todos: string }).todos,
    '1. [completed] a',
  );
});

test('#20 a TodoWrite result is correlated by toolUseId even with no toolName', () => {
  // The live SDK emits tool_result with toolName "" and history keys results by
  // toolUseId, so the result does not classify as plan_update; it must still be
  // skipped (not leaked as raw "TODO List Updated" activity) via toolUseId.
  const call = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [completed] a' },
    toolUseId: 'tu1',
  });
  const result = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'tu1',
    text: 'TODO List Updated',
  });
  const unrelated = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'other',
    text: 'grep output',
  });
  assert.equal(isResultFor(call, result), true);
  assert.equal(isResultFor(call, unrelated), false);
  // No correlation ids on either side: fall back to the adjacent-result convention.
  const bareCall = ev({ kind: 'tool_call', toolName: 'TodoWrite', toolArgs: { todos: 'x' } });
  const bareResult = ev({ kind: 'tool_result', toolName: '', text: 'TODO List Updated' });
  assert.equal(isResultFor(bareCall, bareResult), true);
  // A non-result neighbour is never swallowed.
  assert.equal(isResultFor(call, asst('done')), false);
  assert.equal(isResultFor(call, undefined), false);
});

// ── #18: final answer always top-level, even with trailing compaction ──

test('#18 a final answer followed by compaction stays a top-level message', () => {
  const events = [userMsg('q'), grep(), asst('the answer'), compaction()];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['the answer']);
  // The answer is not nested inside any Worked group.
  assert.ok(!workedChildren(grouped).some((c) => c.type === 'message'));
  // Compaction renders as its own top-level divider (metadata), after the answer.
  const answerIdx = grouped.findIndex((it) => it.type === 'message' && it.event.author !== 'user');
  const compIdx = grouped.findIndex((it) => it.type === 'status' && it.event.kind === 'compaction');
  assert.ok(answerIdx >= 0 && compIdx > answerIdx);
});

test('#18 pre-answer work folds into Worked but the answer never does', () => {
  const events = [userMsg('q'), grep(), asst('answer'), compaction()];
  const grouped = groupTurns(buildFeed(events), false);
  // Exactly one Worked group (the grep), and it carries no assistant message.
  const worked = grouped.filter((it) => it.type === 'worked');
  assert.equal(worked.length, 1);
  assert.ok(!workedChildren(grouped).some((c) => c.type === 'message'));
});

test('#18 multiple assistant texts in a turn each stay top-level', () => {
  const events = [userMsg('q'), asst('first'), grep(), asst('second')];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['first', 'second']);
});

// ── #14: spec mode must not capture normal chat responses ──

test('#14 a normal assistant response still renders in chat while a spec exists', () => {
  const events = [userMsg('hi'), asst('a perfectly normal answer')];
  const html = renderToStaticMarkup(
    createElement(MessageFeed, {
      events,
      pending: false,
      specContent: '# Specification\n\nSome unrelated spec doc',
    }),
  );
  // The normal answer is NOT swallowed by the spec surface just because spec
  // content is present (the old blanket spec-draft suppression bug).
  assert.ok(html.includes('a perfectly normal answer'));
});

test('#14 an assistant message that is exactly the spec text is not double-rendered in chat', () => {
  const spec = '# Specification\n\nThe one and only spec body';
  const events = [userMsg('hi'), asst(spec)];
  const html = renderToStaticMarkup(
    createElement(MessageFeed, { events, pending: false, specContent: spec }),
  );
  // The pinned spec card is present (its title renders)...
  assert.ok(html.includes('Specification'));
  // ...and the identical assistant message is suppressed from the chat stream,
  // so the spec body is not duplicated as a normal chat row (the card body is
  // collapsed by default, hence absent here).
  const occurrences = html.split('The one and only spec body').length - 1;
  assert.equal(occurrences, 0);
});
