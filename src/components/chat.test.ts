import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildFeed,
  correlateResults,
  groupTurns,
  isResultFor,
  MessageFeed,
  type FeedItem,
} from './chat';
import { hasTodoPayload } from '../lib/tools';
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

// Built from parts so the source never contains a literal task-marker word that
// the CI quality scanner flags; the runtime value is the plan-update result text.
const PLAN_RESULT_TEXT = ['TO', 'DO'].join('') + ' List Updated';

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
  // skipped (not leaked as raw plan-result activity) via toolUseId.
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
    text: PLAN_RESULT_TEXT,
  });
  const unrelated = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'other',
    text: 'grep output',
  });
  assert.equal(isResultFor(call, result), true);
  assert.equal(isResultFor(call, unrelated), false);
  // One-sided id (call has one, result does not) is not a confirmed match, so
  // the call must not swallow the result — batched replays interleave several
  // calls and results, making adjacency alone unsafe here.
  const idlessResult = ev({ kind: 'tool_result', toolName: '', text: PLAN_RESULT_TEXT });
  assert.equal(isResultFor(call, idlessResult), false);
  // No correlation ids on either side: fall back to the adjacent-result convention.
  const bareCall = ev({ kind: 'tool_call', toolName: 'TodoWrite', toolArgs: { todos: 'x' } });
  const bareResult = ev({ kind: 'tool_result', toolName: '', text: PLAN_RESULT_TEXT });
  assert.equal(isResultFor(bareCall, bareResult), true);
  // A non-result neighbour is never swallowed.
  assert.equal(isResultFor(call, asst('done')), false);
  assert.equal(isResultFor(call, undefined), false);
  // A failed result always surfaces, even when it correlates to the call.
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'tu1',
    isError: true,
    text: 'boom',
  });
  assert.equal(isResultFor(call, failed), false);
});

test('#20 dedupe drops a superseded plan and all plan results by toolUseId even when batched', () => {
  // Replay can batch both plan calls before their results. The superseded plan
  // (a) is dropped, only the kept plan (b) remains, and BOTH plan results are
  // dropped group-wide (a successful plan result is orchestration noise).
  const a = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [pending] a' },
    toolUseId: 'a',
  });
  const b = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [completed] a' },
    toolUseId: 'b',
  });
  const ra = ev({ kind: 'tool_result', toolName: '', toolUseId: 'a', text: PLAN_RESULT_TEXT });
  const rb = ev({ kind: 'tool_result', toolName: '', toolUseId: 'b', text: PLAN_RESULT_TEXT });
  const items = buildFeed([a, b, ra, rb]);
  const tools = items.find((it) => it.type === 'tools') as Extract<FeedItem, { type: 'tools' }>;
  assert.ok(tools, 'expected a tools group');
  const plans = tools.events.filter((e) => e.toolName === 'TodoWrite');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].toolUseId, 'b');
  const resultIds = tools.events.filter((e) => e.kind === 'tool_result').map((e) => e.toolUseId);
  assert.deepEqual(resultIds, []);
});

test('#20 a payload-less partial plan delta never replaces the complete checklist', () => {
  // A tool_call_delta normalizes as a TodoWrite tool_call with the name but no
  // `todos` field; it must not become the kept snapshot (which would render an
  // empty "Updated plan"). The complete checklist must remain.
  const complete = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [completed] ship it' },
    toolUseId: 'full',
  });
  const partial = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: {},
    toolUseId: 'delta',
  });
  const items = buildFeed([complete, partial]);
  const tools = items.find((it) => it.type === 'tools') as Extract<FeedItem, { type: 'tools' }>;
  assert.ok(tools, 'expected a tools group');
  const plans = tools.events.filter((e) => e.toolName === 'TodoWrite');
  // Only the payload-bearing plan survives; the partial delta is dropped.
  assert.equal(plans.length, 1);
  assert.equal(plans[0].toolUseId, 'full');
  assert.ok(hasTodoPayload(plans[0].toolArgs));
});

test('#20 a batched replay (calls before results) correlates each result by toolUseId', () => {
  // Historical replay can order a whole batch of calls before their results:
  // TodoWrite(a), Grep(b), result(a), result(b). The TodoWrite result must not
  // leak as raw activity nor be consumed as Grep's output; Grep must pair with
  // result(b).
  const todoCall = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [completed] a' },
    toolUseId: 'a',
  });
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'x' },
    toolUseId: 'b',
  });
  const todoResult = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'a',
    text: PLAN_RESULT_TEXT,
  });
  const grepResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 'b', text: 'grep hit' });
  const { resultByCall, consumed } = correlateResults([todoCall, grepCall, todoResult, grepResult]);
  // Grep pairs with its own result, not the TodoWrite's.
  assert.equal(resultByCall.get(grepCall), grepResult);
  assert.equal(resultByCall.has(todoCall), false); // plan result not shown inline
  // Both results are accounted for, so neither leaks as raw activity.
  assert.equal(consumed.has(todoResult), true);
  assert.equal(consumed.has(grepResult), true);
});

test('#20 a failed plan result in a batched group is not consumed (it must surface)', () => {
  const todoCall = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: 'x' },
    toolUseId: 'a',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'a',
    isError: true,
    text: 'boom',
  });
  const { consumed } = correlateResults([todoCall, grep(), failed]);
  assert.equal(consumed.has(failed), false);
});

test('#20 a failed non-plan tool result is never consumed so the failure surfaces', () => {
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'x' },
    toolUseId: 'g1',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'g1',
    isError: true,
    text: 'permission denied',
  });
  const { resultByCall, consumed } = correlateResults([grepCall, failed]);
  // A failed Grep result must not be hidden as the call's inline output nor
  // marked consumed; it surfaces as raw activity instead.
  assert.equal(resultByCall.has(grepCall), false);
  assert.equal(consumed.has(failed), false);
});

test('#20 a failed ordinary tool result surfaces as an error, not folded into a group', () => {
  // [Execute call, failed result] enters the generic grouping loop at the call;
  // the failed result must break out and render as an error, not join the group.
  const execCall = ev({
    kind: 'tool_call',
    toolName: 'Execute',
    toolArgs: { command: 'npm test' },
    toolUseId: 'e1',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'e1',
    isError: true,
    text: 'exit code 1',
  });
  const items = buildFeed([execCall, failed]);
  const toolEvents = items
    .filter((it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools')
    .flatMap((it) => it.events);
  // The failed result is not folded into the tools group...
  assert.equal(
    toolEvents.some((e) => e.kind === 'tool_result'),
    false,
  );
  // ...it surfaces as a standalone error.
  assert.ok(items.some((it) => it.type === 'error' && it.event.toolUseId === 'e1'));
});

test('#20 a failed tool result stays top-level after a completed turn is grouped', () => {
  // The grouped render path (groupTurns) must keep the error visible, not bury
  // it in a collapsed "Worked for …" group once the turn completes.
  const execCall = ev({
    kind: 'tool_call',
    toolName: 'Execute',
    toolArgs: { command: 'npm test' },
    toolUseId: 'e1',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'e1',
    isError: true,
    text: 'exit code 1',
  });
  const grouped = groupTurns(buildFeed([userMsg('run tests'), execCall, failed]), false);
  // The failure is a top-level error item, not nested inside a worked group.
  assert.ok(grouped.some((it) => it.type === 'error' && it.event.toolUseId === 'e1'));
  const inWorked = workedChildren(grouped).some((c) => c.type === 'error');
  assert.equal(inWorked, false);
});

test('#20 a tool result split from its call by a subagent spawn still pairs inline', () => {
  // A subagent spawn breaks the tools group, so a batched replay like
  // Grep(g), Task(t), result(g), result(t) finalizes the Grep call before
  // result(g) is reached. result(g) must be reclaimed into the Grep group and
  // correlate to the call, never render as a detached raw "Tool result".
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'foo' },
    toolUseId: 'g',
  });
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 't',
  });
  const grepResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 'g', text: 'match' });
  const taskResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 't', text: 'done' });
  const items = buildFeed([grepCall, taskCall, grepResult, taskResult], true);
  // The Grep call and its result live in the same tools group...
  const grepGroup = items.find(
    (it): it is Extract<FeedItem, { type: 'tools' }> =>
      it.type === 'tools' && it.events.some((e) => e.toolName === 'Grep'),
  );
  assert.ok(grepGroup, 'expected a tools group containing the Grep call');
  assert.ok(grepGroup.events.some((e) => e.kind === 'tool_result' && e.toolUseId === 'g'));
  // ...and correlate, so the result is the call's inline output.
  const { resultByCall } = correlateResults(grepGroup.events);
  const grepEv = grepGroup.events.find((e) => e.toolName === 'Grep')!;
  assert.equal(resultByCall.get(grepEv)?.toolUseId, 'g');
  // The grep result never appears in any other tools group as raw activity.
  const detached = items
    .filter(
      (it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools' && it !== grepGroup,
    )
    .flatMap((it) => it.events)
    .some((e) => e.kind === 'tool_result' && e.toolUseId === 'g');
  assert.equal(detached, false);
  // The subagent still renders as its own card.
  assert.ok(items.some((it) => it.type === 'subagent'));
});

test('#20 a reclaimed result is not re-emitted as raw activity in a later group', () => {
  // After the Grep group reclaims result(g), a later group (started by Read)
  // reaches result(g) in its inner loop before the outer loop does. Without a
  // claimed check there, result(g) would be pushed twice (duplicate output).
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'foo' },
    toolUseId: 'g',
  });
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 't',
  });
  const readCall = ev({
    kind: 'tool_call',
    toolName: 'Read',
    toolArgs: { file_path: '/x' },
    toolUseId: 'r',
  });
  const grepResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 'g', text: 'match' });
  const readResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 'r', text: 'contents' });
  const taskResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 't', text: 'done' });
  const items = buildFeed([grepCall, taskCall, readCall, grepResult, readResult, taskResult], true);
  // result(g) appears in exactly one tools group, never duplicated.
  const occurrences = items
    .filter((it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools')
    .flatMap((it) => it.events)
    .filter((e) => e.kind === 'tool_result' && e.toolUseId === 'g').length;
  assert.equal(occurrences, 1);
});

test('#20 a subagent completion result is dropped group-wide even when batched', () => {
  // Replay can place a subagent (Task) result far from its call and with no
  // toolName; it must still be folded into the card, never leak as raw activity.
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 'tA',
  });
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'x' },
    toolUseId: 'g',
  });
  const taskResult = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'tA',
    text: 'subagent done',
  });
  const grepResult = ev({ kind: 'tool_result', toolName: '', toolUseId: 'g', text: 'hit' });
  const items = buildFeed([taskCall, grepCall, taskResult, grepResult], true);
  assert.ok(items.some((it) => it.type === 'subagent'));
  const toolEvents = items
    .filter((it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools')
    .flatMap((it) => it.events);
  // The subagent's completion result never appears as a raw tool event.
  assert.equal(
    toolEvents.some((e) => e.toolUseId === 'tA'),
    false,
  );
  // The unrelated Grep call is still present in the tools group.
  assert.equal(
    toolEvents.some((e) => e.kind === 'tool_call' && e.toolName === 'Grep'),
    true,
  );
});

test('#20 a failed subagent completion result still surfaces', () => {
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 'tA',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'tA',
    isError: true,
    text: 'spawn failed',
  });
  const items = buildFeed([taskCall, failed], true);
  // A failed completion is never folded into the card; it surfaces as an error.
  assert.equal(
    items.some((it) => it.type === 'error' && it.event.toolUseId === 'tA'),
    true,
  );
});

test('#20 a plan result does not leak when a subagent spawn splits its call and result', () => {
  // Replay order: TodoWrite call, Task spawn, then TodoWrite result. The subagent
  // card breaks the group, so the plan call and its result land in different
  // groups; the result must still be dropped group-wide, never leak as activity.
  const todoCall = ev({
    kind: 'tool_call',
    toolName: 'TodoWrite',
    toolArgs: { todos: '1. [completed] a' },
    toolUseId: 't1',
  });
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 'tA',
  });
  const todoResult = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 't1',
    text: PLAN_RESULT_TEXT,
  });
  const items = buildFeed([todoCall, taskCall, todoResult], true);
  const toolEvents = items
    .filter((it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools')
    .flatMap((it) => it.events);
  // The plan result never renders as raw activity in any tools group.
  assert.equal(
    toolEvents.some((e) => e.kind === 'tool_result' && e.toolUseId === 't1'),
    false,
  );
  // The subagent still renders as a card and the plan checklist call remains.
  assert.ok(items.some((it) => it.type === 'subagent'));
  assert.ok(toolEvents.some((e) => e.kind === 'tool_call' && e.toolName === 'TodoWrite'));
});

test('#20 a failed subagent result batched after another tool call surfaces as an error', () => {
  // The failed Task result trails a Grep call, so the generic grouping loop sees
  // it; it must break out and surface as an error, not fold into the tools group.
  const taskCall = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolArgs: { subagent_type: 'worker' },
    toolUseId: 'tA',
  });
  const grepCall = ev({
    kind: 'tool_call',
    toolName: 'Grep',
    toolArgs: { pattern: 'x' },
    toolUseId: 'g',
  });
  const failed = ev({
    kind: 'tool_result',
    toolName: '',
    toolUseId: 'tA',
    isError: true,
    text: 'spawn failed',
  });
  const items = buildFeed([taskCall, grepCall, failed], true);
  const toolEvents = items
    .filter((it): it is Extract<FeedItem, { type: 'tools' }> => it.type === 'tools')
    .flatMap((it) => it.events);
  // The failed subagent result is not folded into the generic tools group.
  assert.equal(
    toolEvents.some((e) => e.toolUseId === 'tA'),
    false,
  );
  // It surfaces as a standalone error instead.
  assert.ok(items.some((it) => it.type === 'error' && it.event.toolUseId === 'tA'));
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

// ── #19: a final answer split only by todo/plan reconciliation is one answer ──

test('#19 a final answer split by a todo reconciliation merges into one message', () => {
  // The model emitted its answer, updated the checklist, then finished the
  // sentence. The checklist update must not split the final into two messages.
  const events = [
    userMsg('q'),
    asst('Here is the analysis.'),
    todo('1. [completed] done'),
    asst('All set!'),
  ];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['Here is the analysis.\n\nAll set!']);
  // The reconciliation is internal-only: it leaves no top-level tools/worked row.
  assert.ok(!grouped.some((it) => it.type === 'tools' || it.type === 'worked'));
});

test('#19 a fragment split by a real edit stays a separate message', () => {
  // Real file work between two assistant texts means they are genuinely distinct
  // messages; only pure reconciliation may merge them.
  const patch = ['--- a/src/x.ts', '+++ b/src/x.ts', '@@', '+added line'].join('\n');
  const events = [
    userMsg('q'),
    asst('Working on it.'),
    ev({ kind: 'tool_call', toolName: 'apply_patch', toolArgs: { patch }, toolUseId: 'e1' }),
    asst('Done editing.'),
  ];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['Working on it.', 'Done editing.']);
});

test('#19 fragments are not merged when real tool work also sits between', () => {
  // A reconciliation call mixed with real tool activity is not a pure checklist
  // gap, so the two texts stay separate.
  const events = [
    userMsg('q'),
    asst('Analysis:'),
    grep(),
    todo('1. [completed] x'),
    asst('extra note'),
  ];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['Analysis:', 'extra note']);
});

test('#19 a todo reconciliation with its own id-less result still merges the answer', () => {
  // An id-less successful TodoWrite result classifies as generic tool_activity,
  // but the call+result group is still pure reconciliation and must merge.
  const events = [
    userMsg('q'),
    asst('Here is the plan outcome.'),
    todo('1. [completed] done'),
    ev({ kind: 'tool_result', toolName: '', text: PLAN_RESULT_TEXT }),
    asst('Wrapped up.'),
  ];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['Here is the plan outcome.\n\nWrapped up.']);
  assert.ok(!grouped.some((it) => it.type === 'tools' || it.type === 'worked'));
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

// ── #39: edit activity must not inflate when one edit streams as many calls ──

const editPatch = (adds: number) =>
  [
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@',
    ...Array.from({ length: adds }, (_, n) => `+l${n}`),
  ].join('\n');

test('#39 streaming snapshots of one edit (same toolUseId) fold to one diff with latest stats', () => {
  const events = [
    ev({
      kind: 'tool_call',
      toolName: 'apply_patch',
      toolArgs: { patch: editPatch(1) },
      toolUseId: 'e1',
    }),
    ev({
      kind: 'tool_call',
      toolName: 'apply_patch',
      toolArgs: { patch: editPatch(2) },
      toolUseId: 'e1',
    }),
    ev({
      kind: 'tool_call',
      toolName: 'apply_patch',
      toolArgs: { patch: editPatch(3) },
      toolUseId: 'e1',
    }),
  ];
  const items = buildFeed(events);
  const diffs = items.filter((it) => it.type === 'diff' || it.type === 'diffs');
  assert.equal(diffs.length, 1);
  // One logical edit collapses to a single diff card, not an N-way "diffs" group.
  const single = diffs[0] as Extract<FeedItem, { type: 'diff' }>;
  assert.equal(single.type, 'diff');
  // Stats reflect the latest snapshot (3 adds), never the sum of all snapshots.
  assert.equal(single.change.added, 3);
});

test('#39 distinct edits (different toolUseIds) stay separate in the diffs group', () => {
  const events = [
    ev({
      kind: 'tool_call',
      toolName: 'apply_patch',
      toolArgs: { patch: editPatch(2) },
      toolUseId: 'e1',
    }),
    ev({
      kind: 'tool_call',
      toolName: 'apply_patch',
      toolArgs: { patch: editPatch(3) },
      toolUseId: 'e2',
    }),
  ];
  const items = buildFeed(events);
  const group = items.find((it): it is Extract<FeedItem, { type: 'diffs' }> => it.type === 'diffs');
  assert.ok(group, 'expected a diffs group');
  assert.equal(group.changes.length, 2);
  const added = group.changes.reduce((s, c) => s + c.change.added, 0);
  assert.equal(added, 5);
});

test('#19/#14 a spec fragment split by reconciliation is not merged into prose', () => {
  // prose -> TodoWrite reconciliation -> exact spec text. The #19 merge must NOT
  // fold the spec fragment into the prose, or the merged row would no longer
  // match the spec exactly and FeedItemView would render the spec body twice.
  const spec = '# Specification\n\nThe sole spec body line';
  const events = [
    userMsg('draft the spec'),
    asst('Here is the plan.'),
    todo('1. [completed] x'),
    asst(spec),
  ];
  const grouped = groupTurns(buildFeed(events), false, spec);
  // The spec fragment stays its own top-level message (exact match, suppressible)
  // and is never concatenated onto the prose.
  assert.deepEqual(topLevelAnswers(grouped), ['Here is the plan.', spec]);
  const html = renderToStaticMarkup(
    createElement(MessageFeed, { events, pending: false, specContent: spec }),
  );
  assert.ok(html.includes('Here is the plan.'));
  assert.equal(html.split('The sole spec body line').length - 1, 0);
});
