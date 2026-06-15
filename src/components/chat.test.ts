import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeed, groupTurns, type FeedItem } from './chat';
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
const asst = (text: string, final = false) => ev({ kind: 'text', text, final });
const todo = (todos: string) => ev({ kind: 'tool_call', toolName: 'TodoWrite', toolArgs: { todos } });
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
  const events = [userMsg('do it'), todo('1. [in_progress] step'), asst('done', true)];
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
  assert.equal(plans[0].toolArgs && (plans[0].toolArgs as { todos: string }).todos, '1. [completed] a');
});

// ── #18: final answer always top-level, even with trailing compaction ──

test('#18 a final answer followed by compaction stays a top-level message', () => {
  const events = [userMsg('q'), grep(), asst('the answer', true), compaction()];
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
  const events = [userMsg('q'), grep(), asst('answer', true), compaction()];
  const grouped = groupTurns(buildFeed(events), false);
  // Exactly one Worked group (the grep), and it carries no assistant message.
  const worked = grouped.filter((it) => it.type === 'worked');
  assert.equal(worked.length, 1);
  assert.ok(!workedChildren(grouped).some((c) => c.type === 'message'));
});

test('#18 multiple assistant texts in a turn each stay top-level', () => {
  const events = [userMsg('q'), asst('first'), grep(), asst('second', true)];
  const grouped = groupTurns(buildFeed(events), false);
  assert.deepEqual(topLevelAnswers(grouped), ['first', 'second']);
});
