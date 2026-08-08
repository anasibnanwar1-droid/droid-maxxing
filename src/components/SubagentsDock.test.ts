import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildFeed, groupTurns, MessageFeed, trailingSubagentPoll } from './chat';
import { SubagentsDock } from './SubagentsDock';
import { isPendingChildPlaceholder, resolveWaveSessions } from '../lib/childSessions';
import { childSessionInfo } from '../lib/tools';
import type { ChildSessionSummary, ChildStatus, TranscriptEvent } from '../types/bridge';

let seq = 0;
function ev(extra: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    id: `e${seq++}`,
    appSessionId: 'm',
    sourceSessionId: 'primary',
    role: 'primary',
    ts: seq,
    kind: 'text',
    ...extra,
  } as TranscriptEvent;
}

const userMsg = (text: string) => ev({ kind: 'text', author: 'user', text });
const assistantMsg = (text: string) => ev({ kind: 'text', author: 'assistant', text });
const spawn = (toolUseId: string, label: string) =>
  ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolUseId,
    toolArgs: { subagent_type: label, description: `${label} work` },
  });

function childSession(
  childSessionId: string,
  toolUseId: string,
  status: ChildStatus,
): ChildSessionSummary {
  return {
    parentAppSessionId: 'm',
    childSessionId,
    role: 'worker',
    status,
    label: childSessionId,
    modelId: 'droid-core',
    spawnLink: { kind: 'tool-use', id: toolUseId },
    transcriptAvailable: true,
    startedAt: 1_000,
  };
}

const dockData = {
  sessions: [childSession('explorer', 't1', 'running'), childSession('worker', 't2', 'completed')],
  models: [],
};

// Adjacent text expressions render with comment separators; strip them so text
// assertions match what a user reads.
const textOf = (html: string) => html.replace(/<!--.*?-->/g, '');

// A tool group shimmers its summary only while the step is still running.
const LIVE_SUMMARY_CLASS = 'shimmer-text text-[13px] font-medium';
const SETTLED_SUMMARY_CLASS =
  'text-[13px] text-droid-text-muted group-hover:text-droid-text-secondary transition-colors';

test('live runtime activity outranks the stored status', () => {
  const text = textOf(
    renderToStaticMarkup(
      createElement(SubagentsDock, {
        sessions: [childSession('a', 't1', 'running')],
        models: [],
        activity: () => ({ status: 'completed' }),
      }),
    ),
  );
  assert.ok(text.includes('1 Done'));
  assert.ok(!text.includes('1 Running'));
});

test('collapsed dock shows grouped status counts, not per-agent rows', () => {
  const text = textOf(renderToStaticMarkup(createElement(SubagentsDock, dockData)));
  assert.ok(text.includes('Subagents'));
  assert.ok(text.includes('1 Running'));
  assert.ok(text.includes('1 Done'));
  // Names live in the expanded rows, which stay unmounted while collapsed.
  assert.ok(!text.includes('explorer'));
  assert.ok(!text.includes('worker'));
});

test('dock mode groups a consecutive spawn wave into one feed item', () => {
  const items = buildFeed([userMsg('go'), spawn('t1', 'explorer'), spawn('t2', 'worker')], {
    childSessionCards: true,
    groupChildSessions: true,
  });
  assert.deepEqual(
    items.map((item) => item.type),
    ['message', 'child_sessions'],
  );
  const wave = items[1];
  assert.equal(wave.type, 'child_sessions');
  if (wave.type === 'child_sessions') {
    assert.deepEqual(
      wave.events.map((e) => e.toolUseId),
      ['t1', 't2'],
    );
  }
});

test('each spawn run gets its own wave item, not a session-wide accumulation', () => {
  const items = buildFeed(
    [
      userMsg('one'),
      spawn('t1', 'explorer'),
      assistantMsg('first wave done'),
      spawn('t2', 'worker'),
    ],
    { childSessionCards: true, groupChildSessions: true },
  );
  const waves = items.filter((item) => item.type === 'child_sessions');
  assert.equal(waves.length, 2);
  assert.deepEqual(
    waves.map((wave) => wave.type === 'child_sessions' && wave.events.map((e) => e.toolUseId)),
    [['t1'], ['t2']],
  );
  // Keys are distinct so each card mounts as its own component instance.
  assert.notEqual(waves[0].key, waves[1].key);
});

test('a completed turn folds the wave card into its Worked group', () => {
  const items = groupTurns(
    buildFeed([userMsg('go'), spawn('t1', 'explorer'), assistantMsg('done')], {
      childSessionCards: true,
      groupChildSessions: true,
    }),
    false,
  );
  assert.deepEqual(
    items.map((item) => item.type),
    ['message', 'worked', 'message'],
  );
  const worked = items[1];
  assert.equal(worked.type, 'worked');
  if (worked.type === 'worked') {
    assert.deepEqual(
      worked.items.map((item) => item.type),
      ['child_sessions'],
    );
  }
  // Nothing wave-shaped is left floating at the top level.
  assert.ok(!items.some((item) => item.type === 'child_sessions'));
});

test('an in-flight turn renders the wave as a dock instead of per-spawn lines', () => {
  const events = [userMsg('go'), spawn('t1', 'explorer'), spawn('t2', 'worker')];
  const text = textOf(
    renderToStaticMarkup(
      createElement(MessageFeed, {
        events,
        pending: true,
        onOpenChildSession: () => {},
        subagentsDock: dockData,
      }),
    ),
  );
  assert.equal(text.match(/Subagents/g)?.length, 1);
  assert.ok(!text.includes('Spawned'));
});

test('two in-flight waves render two docks, each scoped to its own agents', () => {
  const events = [
    userMsg('go'),
    spawn('t1', 'explorer'),
    assistantMsg('first wave running'),
    spawn('t2', 'worker'),
  ];
  const text = textOf(
    renderToStaticMarkup(
      createElement(MessageFeed, {
        events,
        pending: true,
        onOpenChildSession: () => {},
        subagentsDock: dockData,
      }),
    ),
  );
  assert.equal(text.match(/Subagents/g)?.length, 2);
  // Wave 1 holds only the running explorer; wave 2 only the completed worker.
  assert.ok(text.includes('1 Running'));
  assert.ok(text.includes('1 Done'));
  // The header summarizes completion; the pills carry the status breakdown.
  assert.ok(!text.includes('spawned'));
  assert.ok(text.includes('All 1 subagent finished'));
  assert.ok(text.includes('0 of 1 subagent finished'));
  assert.ok(!text.includes('Spawned'));
});

test('the card reads as status pills plus a completion summary', () => {
  const text = textOf(
    renderToStaticMarkup(
      createElement(SubagentsDock, {
        sessions: [
          childSession('a', 't1', 'running'),
          childSession('b', 't2', 'running'),
          childSession('c', 't3', 'paused'),
          childSession('d', 't4', 'completed'),
        ],
        models: [],
      }),
    ),
  );
  assert.ok(text.includes('2 Running'));
  assert.ok(text.includes('1 Idle'));
  assert.ok(text.includes('1 Done'));
  assert.ok(text.includes('1 of 4 subagents finished'));
  assert.ok(text.includes('25%'));
});

test('a live wave reads as working and never claims Done from the spawn call ending', () => {
  // A background Task acknowledges its launch immediately, so the spawn call
  // already carries an endTs while the subagent is only starting up.
  const launched = { ...spawn('t1', 'explorer'), endTs: 2_000 };
  const wave = resolveWaveSessions([launched], [], true);
  assert.equal(wave[0].status, 'running');
  const text = textOf(
    renderToStaticMarkup(createElement(SubagentsDock, { sessions: wave, models: [], live: true })),
  );
  assert.ok(text.includes('1 Running'));
  assert.ok(text.includes('0 of 1 subagent finished'));
  assert.ok(!text.includes('Done'));

  // Once the turn ends, the same spawn is settled rather than eternally running.
  assert.equal(resolveWaveSessions([launched], [], false)[0].status, 'completed');
});

test('the dock renders instantly from spawn events, before sessions register', () => {
  const events = [userMsg('go'), spawn('t1', 'explorer')];
  const text = textOf(
    renderToStaticMarkup(
      createElement(MessageFeed, {
        events,
        pending: true,
        onOpenChildSession: () => {},
        subagentsDock: { sessions: [], models: [] },
      }),
    ),
  );
  // No resolved sessions yet: a placeholder stands in so the card never flashes
  // per-spawn lines while the store catches up.
  assert.ok(text.includes('Subagents'));
  assert.ok(text.includes('1 Running'));
  assert.ok(!text.includes('Spawned'));
});

test('a wave stays live once later items follow it in the same turn', () => {
  // The parent keeps talking (plan updates, narration) while its subagents work,
  // so "is this wave live" cannot be "is this the last feed item".
  const events = [userMsg('go'), spawn('t1', 'explorer'), assistantMsg('spawned the explorer')];
  const text = textOf(
    renderToStaticMarkup(
      createElement(MessageFeed, {
        events,
        pending: true,
        onOpenChildSession: () => {},
        subagentsDock: { sessions: [], models: [] },
      }),
    ),
  );
  assert.ok(text.includes('1 Running'));
  assert.ok(!text.includes('Never started'));
});

test('polling and stopping subagents never renders rows beside the card', () => {
  const poll = (toolUseId: string, toolName: string) =>
    ev({ kind: 'tool_call', toolName, toolUseId, toolArgs: { task_id: 'abc' } });
  const pollResult = (toolUseId: string) =>
    ev({
      kind: 'tool_result',
      toolUseId,
      text: 'Task ID: abc\nStatus: running\n\nreading the sidecar',
    });
  const events = [
    userMsg('go'),
    spawn('t1', 'explorer'),
    poll('p1', 'TaskOutput'),
    pollResult('p1'),
    poll('p2', 'TaskStop'),
    pollResult('p2'),
  ];
  const text = textOf(
    renderToStaticMarkup(
      createElement(MessageFeed, {
        events,
        pending: true,
        onOpenChildSession: () => {},
        subagentsDock: { sessions: [], models: [] },
      }),
    ),
  );
  assert.ok(text.includes('Subagents'));
  // The card speaks for the polls; neither the calls nor their echoed bodies
  // may appear as tool rows.
  assert.ok(!text.includes('TaskOutput'));
  assert.ok(!text.includes('TaskStop'));
  assert.ok(!text.includes('reading the sidecar'));
});

test('a poll after a finished step reads as checking subagents, not a stuck step', () => {
  // The parent finished a search and is now polling its subagents. The poll is
  // suppressed, so the search group is the feed's last item: it must read as
  // settled while the cue reports what the parent is actually doing.
  const events = [
    userMsg('go'),
    spawn('t1', 'explorer'),
    ev({ kind: 'tool_call', toolName: 'Grep', toolUseId: 'g1', toolArgs: { pattern: 'foo' } }),
    ev({ kind: 'tool_result', toolUseId: 'g1', text: 'src/a.ts:1: foo' }),
    ev({
      kind: 'tool_call',
      toolName: 'TaskOutput',
      toolUseId: 'p1',
      toolArgs: { task_id: 'abc' },
    }),
  ];
  const html = renderToStaticMarkup(
    createElement(MessageFeed, {
      events,
      pending: true,
      onOpenChildSession: () => {},
      subagentsDock: dockData,
    }),
  );
  assert.ok(textOf(html).includes('Checking subagents'));
  assert.ok(html.includes(`${SETTLED_SUMMARY_CLASS}">Explored 1 search`));
  assert.ok(!html.includes(`${LIVE_SUMMARY_CLASS}">Explored 1 search`));
});

test('a poll after the parent stopped talking still shows the parent working', () => {
  // An assistant message self-indicates with a caret, so a settled one at the
  // tail would leave the whole feed looking stopped while the parent polls.
  const events = [
    userMsg('go'),
    spawn('t1', 'explorer'),
    assistantMsg('spawned the explorer'),
    ev({
      kind: 'tool_call',
      toolName: 'TaskOutput',
      toolUseId: 'p1',
      toolArgs: { task_id: 'abc' },
    }),
    ev({ kind: 'tool_result', toolUseId: 'p1', text: 'Task ID: abc\nStatus: running\n\nworking' }),
  ];
  const text = textOf(
    renderToStaticMarkup(
      createElement(MessageFeed, {
        events,
        pending: true,
        onOpenChildSession: () => {},
        subagentsDock: dockData,
      }),
    ),
  );
  assert.ok(text.includes('Checking subagents'));
});

test('a poll behind a running wave card does not add a second live cue', () => {
  // The card at the tail already reports the wave with its own status pills and
  // timers, so announcing the check as well would say the same thing twice.
  const events = [
    userMsg('go'),
    spawn('t1', 'explorer'),
    ev({
      kind: 'tool_call',
      toolName: 'TaskOutput',
      toolUseId: 'p1',
      toolArgs: { task_id: 'abc' },
    }),
  ];
  const text = textOf(
    renderToStaticMarkup(
      createElement(MessageFeed, {
        events,
        pending: true,
        onOpenChildSession: () => {},
        subagentsDock: { sessions: [childSession('explorer', 't1', 'running')], models: [] },
        childSessionActivity: () => ({ status: 'running' }),
      }),
    ),
  );
  assert.ok(text.includes('Subagents'));
  assert.ok(!text.includes('Checking subagents'));

  // Once the wave settles, the card stops animating and the cue is the only
  // thing left to say the parent is still working.
  const settled = textOf(
    renderToStaticMarkup(
      createElement(MessageFeed, {
        events,
        pending: true,
        onOpenChildSession: () => {},
        subagentsDock: { sessions: [childSession('explorer', 't1', 'completed')], models: [] },
        childSessionActivity: () => ({ status: 'completed' }),
      }),
    ),
  );
  assert.ok(settled.includes('Checking subagents'));
});

test('a poll between two spawn batches keeps them in one wave card', () => {
  // The poll is bookkeeping the card already speaks for, so it must not split
  // the turn's agents into two cards; the card stays where the spawning began.
  const items = buildFeed(
    [
      userMsg('go'),
      spawn('t1', 'explorer'),
      ev({ kind: 'tool_call', toolName: 'TaskOutput', toolUseId: 'p1', toolArgs: {} }),
      ev({ kind: 'tool_result', toolUseId: 'p1', text: 'Task ID: abc\nStatus: completed' }),
      spawn('t2', 'worker'),
    ],
    { childSessionCards: true, groupChildSessions: true },
  );
  const waves = items.filter((item) => item.type === 'child_sessions');
  assert.equal(waves.length, 1);
  if (waves[0].type === 'child_sessions')
    assert.deepEqual(
      waves[0].events.map((e) => e.toolUseId),
      ['t1', 't2'],
    );
});

test('only a suppressed poll at the tail redirects the working cue', () => {
  const poll = ev({ kind: 'tool_call', toolName: 'TaskOutput', toolUseId: 'p1', toolArgs: {} });
  const pollResult = ev({ kind: 'tool_result', toolUseId: 'p1', text: 'Status: running' });
  const read = ev({ kind: 'tool_call', toolName: 'Read', toolUseId: 'r1', toolArgs: {} });

  // The poll call is returned so the cue can time the check from it.
  assert.equal(trailingSubagentPoll([userMsg('go'), poll], true), poll);
  // Replayed results carry no toolName, so the tail resolves through its call.
  assert.equal(trailingSubagentPoll([userMsg('go'), poll, pollResult], true), poll);
  assert.equal(trailingSubagentPoll([userMsg('go'), poll, read], true), undefined);
  assert.equal(trailingSubagentPoll([userMsg('go'), assistantMsg('done')], true), undefined);
  // Views that keep the poll rows render them, so their tail is honest already.
  assert.equal(trailingSubagentPoll([userMsg('go'), poll], false), undefined);
});

test('a poll between two tools does not split them into separate groups', () => {
  const toolCall = (toolUseId: string, toolName: string) =>
    ev({ kind: 'tool_call', toolName, toolUseId, toolArgs: { file_path: `/tmp/${toolUseId}.ts` } });
  const feed = buildFeed(
    [
      toolCall('a', 'Read'),
      ev({ kind: 'tool_call', toolName: 'TaskOutput', toolUseId: 'p1', toolArgs: {} }),
      toolCall('b', 'Grep'),
    ],
    { childSessionCards: true, groupChildSessions: true },
  );
  assert.equal(feed.filter((item) => item.type === 'tools').length, 1);
});

test('views that keep per-spawn lines keep the poll rows too', () => {
  // Mission Control and child-session panes render no wave card, so nothing
  // there would account for a suppressed poll.
  const events = [
    userMsg('go'),
    spawn('t1', 'explorer'),
    ev({
      kind: 'tool_call',
      toolName: 'TaskOutput',
      toolUseId: 'p1',
      toolArgs: { task_id: 'abc' },
    }),
  ];
  const feed = buildFeed(events, { childSessionCards: true, groupChildSessions: false });
  const tools = feed.filter((item) => item.type === 'tools');
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].type === 'tools' && tools[0].events.map((e) => e.toolName), [
    'TaskOutput',
  ]);
});

test('a row is timed from its spawn, not from when the store caught up', () => {
  const spawnEvent = { ...spawn('t1', 'explorer'), ts: Date.now() - 90_000 };
  // The store stamps startedAt at admission, long after a background Task was
  // issued; timing from it would under-report the run by the whole lag.
  const late = { ...childSession('explorer', 't1', 'running'), startedAt: Date.now() - 5_000 };
  const wave = resolveWaveSessions([spawnEvent], [late], true);
  const text = textOf(
    renderToStaticMarkup(
      createElement(SubagentsDock, {
        sessions: wave,
        models: [],
        live: true,
        activity: () => ({ status: 'running', startedAt: late.startedAt }),
      }),
    ),
  );
  assert.ok(text.includes('1m 3'));
  assert.ok(!text.includes('5s'));
});

test('without dock data the per-spawn lines still render (Mission Control path)', () => {
  const events = [userMsg('go'), spawn('t1', 'explorer')];
  const text = textOf(
    renderToStaticMarkup(
      createElement(MessageFeed, { events, pending: false, onOpenChildSession: () => {} }),
    ),
  );
  assert.ok(text.includes('Spawned'));
  assert.ok(!text.includes('Subagents'));
});

test('streaming deltas merge into one wave event instead of duplicating the spawn', () => {
  // A spawn's subagent_type and description can arrive in separate deltas
  // sharing one toolUseId (replayed transcripts are not pre-coalesced).
  const first = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolUseId: 't1',
    toolArgs: { subagent_type: 'explorer' },
  });
  const delta = ev({
    kind: 'tool_call',
    toolName: 'Task',
    toolUseId: 't1',
    toolArgs: { description: 'survey the code' },
  });
  const items = buildFeed([userMsg('go'), first, delta], {
    childSessionCards: true,
    groupChildSessions: true,
  });
  const waves = items.filter((item) => item.type === 'child_sessions');
  assert.equal(waves.length, 1);
  const wave = waves[0];
  if (wave.type !== 'child_sessions') assert.fail('expected a wave item');
  assert.equal(wave.events.length, 1);
  assert.equal(childSessionInfo(wave.events[0].toolArgs).label, 'explorer');
  assert.equal(childSessionInfo(wave.events[0].toolArgs).description, 'survey the code');
});

test('resolveWaveSessions swaps a placeholder for the registered session on the same link', () => {
  const spawnEvent = spawn('t1', 'explorer');
  const pendingWave = resolveWaveSessions([spawnEvent], []);
  assert.equal(pendingWave.length, 1);
  assert.equal(pendingWave[0].status, 'pending');
  assert.ok(isPendingChildPlaceholder(pendingWave[0]));
  // The placeholder carries the task description so the row has something to say.
  assert.equal(pendingWave[0].prompt, 'explorer work');

  const registered = childSession('explorer', 't1', 'running');
  const resolvedWave = resolveWaveSessions([spawnEvent], [registered]);
  // Same single row, same tool-use link: the dock row keeps its key and timer.
  assert.equal(resolvedWave.length, 1);
  assert.equal(resolvedWave[0].childSessionId, registered.childSessionId);
  assert.deepEqual(resolvedWave[0].spawnLink, pendingWave[0].spawnLink);
});

test('a registered row keeps the spawn event time as its true start', () => {
  const spawnEvent = { ...spawn('t1', 'explorer'), ts: 5_000 };
  // The store stamps startedAt at admission, which lags the spawn; the wave's
  // spawn event timestamp is the honest start for the row timer.
  const late = { ...childSession('explorer', 't1', 'running'), startedAt: 12_000 };
  assert.equal(resolveWaveSessions([spawnEvent], [late])[0].startedAt, 5_000);
  const early = { ...childSession('explorer', 't1', 'running'), startedAt: 4_000 };
  assert.equal(resolveWaveSessions([spawnEvent], [early])[0].startedAt, 4_000);
});

test('a replayed spawn that already ended does not sit on Queued forever', () => {
  const finished = { ...spawn('t1', 'explorer'), endTs: 2_000 };
  const wave = resolveWaveSessions([finished], []);
  assert.equal(wave[0].status, 'completed');
});
