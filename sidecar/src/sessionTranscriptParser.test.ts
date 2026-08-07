import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionLineEvents } from './sessionTranscriptParser.js';
import type { TranscriptEvent } from './protocol.js';

function messageLine(opts: {
  role: string;
  content: unknown[];
  visibility?: string;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: 'message',
    id: 'm1',
    timestamp: opts.timestamp ?? new Date(1000).toISOString(),
    message: {
      role: opts.role,
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
      content: opts.content,
    },
  });
}

test('a tool_result with missing content is preserved, not dropped', () => {
  // Regression: block.content was undefined, so stringifyToolResult reached
  // safeStringify(undefined) which returned undefined (not a string), made
  // trimText(undefined) throw, and the surrounding try/catch dropped the whole
  // line — losing this tool_result and any sibling events.
  const line = JSON.parse(
    messageLine({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }),
  );
  const events = parseSessionLineEvents('app', 'provider', 'primary', line);
  const result = events.find((e) => e.kind === 'tool_result');
  assert.ok(result, 'tool_result must survive even with no content body');
  assert.equal(result!.text, '');
  assert.equal(result!.toolUseId, 't1');
});

test('a tool_result with a null JSON literal in its content array is not dropped', () => {
  // A degenerate array element (the literal null) must not crash the parse;
  // the real text block beside it must still surface.
  const line = JSON.parse(
    messageLine({
      role: 'user',
      content: [null, { type: 'tool_result', tool_use_id: 't2', content: 'done' }],
    }),
  );
  const events = parseSessionLineEvents('app', 'provider', 'primary', line);
  const result = events.find((e) => e.kind === 'tool_result') as TranscriptEvent;
  assert.ok(result, 'tool_result must survive a null sibling block');
  assert.equal(result.text, 'done');
});

test('llm_only user messages stay hidden (filtering lives in the parser)', () => {
  const visible = parseSessionLineEvents(
    'app',
    'provider',
    'primary',
    JSON.parse(messageLine({ role: 'user', content: [{ type: 'text', text: 'shown' }] })),
  );
  const hidden = parseSessionLineEvents(
    'app',
    'provider',
    'primary',
    JSON.parse(
      messageLine({
        role: 'user',
        visibility: 'llm_only',
        content: [{ type: 'text', text: 'hidden' }],
      }),
    ),
  );
  assert.deepEqual(
    visible.map((e) => e.text),
    ['shown'],
  );
  assert.deepEqual(hidden, []);
});

test('a mid-file compaction_state record replays as a divider event', () => {
  const line = JSON.parse(
    JSON.stringify({
      type: 'compaction_state',
      id: 'comp-3',
      timestamp: new Date(2000).toISOString(),
      removedCount: 3,
    }),
  );
  const events = parseSessionLineEvents('app', 'provider', 'primary', line);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'compaction');
  assert.equal(events[0].removedCount, 3);
});
